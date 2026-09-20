import net from 'node:net';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { HELPER_ACTIONS, HELPER_MESSAGES } from '../shared/ipc.js';

const DEFAULT_READY_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_MS = 800;

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export class HelperBridge {
  constructor({
    exePath,
    appArgs = [],
    tokenFile = null,
    platform = process.platform,
    logger = console,
    onStatus,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    this.exePath = exePath;
    this.appArgs = appArgs;
    this.tokenFile = tokenFile;
    this.platform = platform;
    this.logger = logger;
    this.onStatus = onStatus || (() => {});
    this.readyTimeoutMs = readyTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.statusValue = 'off';
    this.server = null;
    this.socket = null;
    this.authenticated = false;
    this.token = null;
    this.pipeName = null;
    this.pending = new Map();
    this.buffer = '';
    this.nextId = 1;
    this.startPromise = null;
  }

  get status() {
    return this.statusValue;
  }

  isReady() {
    return this.statusValue === 'ready' && !!this.socket;
  }

  #setStatus(status) {
    if (this.statusValue === status) {
      return;
    }
    this.statusValue = status;
    this.onStatus?.(status);
  }

  async ensureStarted() {
    if (this.isReady()) {
      return { ok: true, status: this.statusValue };
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.platform !== 'win32') {
      this.#setStatus('missing');
      return { ok: false, status: this.statusValue, error: 'unsupported-platform' };
    }

    this.startPromise = this.#start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async #start() {
    this.#setStatus('launching');
    this.token = crypto.randomBytes(16).toString('hex');
    this.pipeName = `\\\\.\\pipe\\sprout-helper-${crypto.randomBytes(8).toString('hex')}`;

    if (this.tokenFile) {
      try {
        await fs.writeFile(this.tokenFile, this.token, 'utf8');
      } catch (error) {
        this.logger.error?.('[sprout-helper] token file write failed', error?.message || error);
      }
    }

    try {
      await this.#listen();
    } catch (error) {
      this.logger.error?.('[sprout-helper] listen failed', error?.message || error);
      this.#teardown();
      this.#setStatus('missing');
      return { ok: false, status: this.statusValue, error: 'pipe-listen-failed' };
    }

    try {
      await this.#launchElevated();
    } catch (error) {
      this.logger.error?.('[sprout-helper] elevation failed', error?.message || error);
      this.#teardown();
      this.#setStatus('missing');
      return { ok: false, status: this.statusValue, error: 'elevation-cancelled' };
    }

    const ready = await this.#waitForReady();
    if (!ready && !this.socket) {
      this.logger.error?.(`[sprout-helper] waitForReady timed out after ${this.readyTimeoutMs}ms`);
      this.#teardown();
      this.#setStatus('missing');
      return { ok: false, status: this.statusValue, error: 'helper-timeout' };
    }

    if (!this.socket) {
      this.#teardown();
      this.#setStatus('missing');
      return { ok: false, status: this.statusValue, error: 'helper-disconnected' };
    }

    this.#setStatus('ready');
    return { ok: true, status: this.statusValue };
  }

  #listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.#onConnection(socket));
      this.server.maxConnections = 1;
      this.server.once('error', reject);
      this.server.listen(this.pipeName, () => resolve());
    });
  }

  #onConnection(socket) {
    socket.setEncoding('utf8');
    let handshakeBuffer = '';
    const onHandshake = (chunk) => {
      handshakeBuffer += chunk;
      let index = handshakeBuffer.indexOf('\n');
      while (index >= 0) {
        const line = handshakeBuffer.slice(0, index).trim();
        handshakeBuffer = handshakeBuffer.slice(index + 1);
        index = handshakeBuffer.indexOf('\n');
        if (!line) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message?.type !== HELPER_MESSAGES.ready || message.token !== this.token) {
          socket.destroy();
          return;
        }

        socket.removeListener('data', onHandshake);
        this.socket = socket;
        this.authenticated = true;
        this.buffer = '';
        socket.on('data', (data) => this.#onData(data));
        socket.on('close', () => this.#onSocketClosed());
        socket.on('error', () => {});
        return;
      }
    };

    socket.on('data', onHandshake);
    socket.on('error', () => {});
  }

  #onData(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      const pending = this.pending.get(message?.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    }
  }

  #onSocketClosed() {
    this.socket = null;
    this.authenticated = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('helper-disconnected'));
    }
    this.pending.clear();
    if (this.statusValue === 'ready') {
      this.#setStatus('missing');
    }
  }

  #waitForReady() {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        if (this.socket && this.authenticated) {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt >= this.readyTimeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 150);
      };
      check();
    });
  }

  #launchElevated() {
    return new Promise((resolve, reject) => {
      const args = [
        ...this.appArgs,
        '--guardian-helper',
        `--helper-pipe=${this.pipeName}`,
      ];
      if (this.tokenFile) {
        args.push(`--helper-token-file=${this.tokenFile}`);
      } else {
        args.push(`--helper-token=${this.token}`);
      }
      const argList = args.map(psQuote).join(',');
      const preamble = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; ";
      const script = `${preamble}Start-Process -FilePath ${psQuote(this.exePath)} -ArgumentList @(${argList}) -Verb RunAs -WindowStyle Hidden`;
      const encoded = encodePowerShell(script);
      const child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || error.stderr || error.message || '').trim();
            this.logger.error?.(`[sprout-helper] elevation failed: ${detail || '(no stderr)'}`);
            const wrapped = new Error('elevation-failed');
            wrapped.detail = detail;
            reject(wrapped);
          } else {
            resolve();
          }
        },
      );
      child.on('error', reject);
    });
  }

  async #request(action, payload = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.isReady()) {
      return { ok: false, error: 'helper-not-ready' };
    }

    const id = this.nextId++;
    const frame = JSON.stringify({ id, action, payload });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'helper-timeout' });
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject: () => resolve({ ok: false, error: 'helper-disconnected' }),
        timer,
      });

      try {
        this.socket.write(`${frame}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: error?.message || 'helper-write-failed' });
      }
    });
  }

  async minimize(windowId) {
    const response = await this.#request(HELPER_ACTIONS.minimize, { windowId });
    if (!response?.ok) {
      return { dispatched: false, error: response?.error || 'helper-failed' };
    }
    return response.result || { dispatched: false, error: 'helper-empty-result' };
  }

  async stop() {
    if (this.socket) {
      await this.#request(HELPER_ACTIONS.shutdown, {}, 400);
    }
    this.#teardown();
    this.#setStatus('off');
  }

  #teardown() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('helper-stopped'));
    }
    this.pending.clear();

    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.authenticated = false;

    if (this.server) {
      try {
        this.server.close();
      } catch {
        // ignore
      }
      this.server = null;
    }

    this.buffer = '';
  }
}

export default HelperBridge;
