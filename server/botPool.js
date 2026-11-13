const { Worker } = require('node:worker_threads');
const path = require('node:path');
/** Bounded global pool: CPU work cannot block Socket.IO or grow without limit. */
class BotPool {
  constructor(size = 2) { this.size = size; this.workers = []; this.queue = []; this.serial = 0; this.closed = false; }
  run(state, options) {
    if (this.closed || this.queue.length >= 64) return Promise.reject(new Error('Bot pool unavailable'));
    return new Promise((resolve, reject) => {
      const job = { id: ++this.serial, state, options, resolve, reject };
      job.timer = setTimeout(() => {
        const slot = this.workers.find(w => w.job === job);
        this.queue = this.queue.filter(j => j !== job); reject(new Error('Bot computation timed out'));
        if (slot) { slot.job = null; slot.worker.terminate(); this.workers = this.workers.filter(w => w !== slot); this.pump(); }
      }, 2500);
      job.timer.unref?.(); this.queue.push(job); this.pump();
    });
  }
  pump() {
    if (this.closed) return;
    while (this.queue.length) {
      let slot = this.workers.find(w => !w.job);
      if (!slot && this.workers.length < this.size) {
        slot = { worker: new Worker(path.join(__dirname, 'botWorker.js')), job: null };
        const current = slot;
        current.worker.unref();
        current.worker.on('message', message => {
          const job = current.job; if (!job || message.id !== job.id) return;
          current.job = null; clearTimeout(job.timer); current.worker.unref();
          if (message.error) job.reject(new Error(message.error)); else job.resolve(message.decision);
          this.pump();
        });
        current.worker.on('error', error => {
          if (current.job) { clearTimeout(current.job.timer); current.job.reject(error); }
          current.job = null; this.workers = this.workers.filter(w => w !== current); this.pump();
        });
        this.workers.push(slot);
      }
      if (!slot) break;
      slot.job = this.queue.shift(); slot.worker.ref();
      slot.worker.postMessage({ id: slot.job.id, state: slot.job.state, options: slot.job.options });
    }
  }
  async close() {
    this.closed = true;
    for (const job of [...this.queue, ...this.workers.map(w => w.job).filter(Boolean)]) { clearTimeout(job.timer); job.reject(new Error('Bot pool closed')); }
    this.queue = []; await Promise.all(this.workers.map(w => w.worker.terminate())); this.workers = [];
  }
}
module.exports = { BotPool };
