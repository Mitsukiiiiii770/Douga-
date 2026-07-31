'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { app } = require('electron');
const engine = require('./engine');
const postprocess = require('./postprocess');
const cookies = require('./cookies');
const settings = require('./settings');

/** 実行中とみなす状態。アプリ終了で中断されるのはこれら */
const ACTIVE_STATUSES = ['queued', 'downloading', 'processing', 'enhancing'];

/** 履歴として残す完了済みジョブの上限 */
const MAX_HISTORY = 200;

/**
 * ダウンロードジョブのキュー。設定の maxConcurrent まで並列に走らせる。
 *
 * ジョブはディスクにも書き出しており、アプリを再起動しても一覧が残る。
 * ただし勝手に再開はしない。起動と同時にダウンロードが走り出すのは
 * 挙動として驚きが大きいので、中断扱いにして「再開」を明示させる。
 */
class Queue extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.running = new Set();
    this.saveTimer = null;
    this.storePath = null;
  }

  file() {
    if (!this.storePath) this.storePath = path.join(app.getPath('userData'), 'jobs.json');
    return this.storePath;
  }

  list() {
    return [...this.jobs.values()].map((job) => this.serialize(job));
  }

  serialize(job) {
    // formats はレンダラーに送る必要がなく、更新のたびに送ると重いので落とす
    const { controller, cookieFile, formats, ...rest } = job;
    return { ...rest, hasCookies: !!cookieFile };
  }

  /** 保存用。Cookie のパスは終了時に消えるので持ち越さない */
  persistable(job) {
    const { controller, cookieFile, ...rest } = job;
    return rest;
  }

  /**
   * 起動時に前回のジョブを読み込む。
   * 実行中だったものは「中断」にして、再開はユーザーの操作に委ねる。
   */
  restore() {
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
    } catch {
      return 0;
    }
    if (!Array.isArray(stored)) return 0;

    for (const saved of stored) {
      if (!saved || !saved.id || !saved.url) continue;
      const job = {
        ...saved,
        controller: null,
        cookieFile: null,
        status: ACTIVE_STATUSES.includes(saved.status) ? 'interrupted' : saved.status,
        speed: null,
        eta: null
      };
      this.jobs.set(job.id, job);
    }
    return this.jobs.size;
  }

  /** 書き込みが集中しないよう、少し遅らせてまとめて保存する */
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 500);
  }

  saveNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const all = [...this.jobs.values()];
      const active = all.filter((j) => ACTIVE_STATUSES.includes(j.status));
      const finished = all
        .filter((j) => !ACTIVE_STATUSES.includes(j.status))
        .slice(-MAX_HISTORY);
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      fs.writeFileSync(
        this.file(),
        JSON.stringify([...active, ...finished].map((j) => this.persistable(j)), null, 2)
      );
    } catch (err) {
      console.error('キューの保存に失敗:', err);
    }
  }

  emitUpdate(job) {
    this.emit('update', this.serialize(job));
    this.save();
  }

  /** 中断されたジョブをまとめて待機中に戻す */
  resumeInterrupted() {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'interrupted') {
        job.status = 'queued';
        job.progress = 0;
        job.error = null;
        this.emitUpdate(job);
        count++;
      }
    }
    if (count) this.pump();
    return count;
  }

  add(spec) {
    const job = {
      id: crypto.randomUUID(),
      url: spec.url,
      title: spec.title || spec.url,
      // 'page' ならページ由来のタイトル。出力ファイル名に直接使う
      titleSource: spec.titleSource || null,
      thumbnail: spec.thumbnail || null,
      duration: spec.duration || null,
      formatId: spec.formatId || null,
      formats: spec.formats || [],
      mode: spec.mode || 'best',
      audioFormat: spec.audioFormat || 'mp3',
      subtitles: !!spec.subtitles,
      embedThumbnail: !!spec.thumbnailEmbed,
      headers: spec.headers || {},
      cookieFile: spec.cookieFile || null,
      outDir: spec.outDir || settings.get().downloadDir,
      qualityLabel: spec.qualityLabel || '',
      sourcePath: null,
      postProcessError: null,
      encodeSpeed: null,
      status: 'queued',
      progress: 0,
      downloaded: null,
      total: null,
      speed: null,
      eta: null,
      filePath: null,
      error: null,
      addedAt: Date.now(),
      controller: null
    };
    this.jobs.set(job.id, job);
    this.emitUpdate(job);
    this.pump();
    return this.serialize(job);
  }

  pump() {
    const max = Math.max(1, Number(settings.get().maxConcurrent) || 2);
    if (this.running.size >= max) return;
    const next = [...this.jobs.values()].find((j) => j.status === 'queued');
    if (!next) return;
    this.start(next);
    // 空きがあれば続けて起動
    if (this.running.size < max) this.pump();
  }

  async start(job) {
    job.status = 'downloading';
    job.error = null;
    job.controller = new AbortController();
    this.running.add(job.id);
    this.emitUpdate(job);

    try {
      const result = await engine.download(job, {
        signal: job.controller.signal,
        onProgress: (p) => {
          if (p.status === 'processing') {
            job.status = 'processing';
          } else if (p.status === 'finished') {
            job.progress = 100;
          } else {
            job.status = 'downloading';
            job.downloaded = p.downloaded;
            job.total = p.total;
            job.speed = p.speed;
            job.eta = p.eta;
            if (p.total && p.downloaded) {
              job.progress = Math.min(100, (p.downloaded / p.total) * 100);
            } else if (p.fragmentCount && p.fragmentIndex) {
              job.progress = Math.min(100, (p.fragmentIndex / p.fragmentCount) * 100);
            }
          }
          this.emitUpdate(job);
        }
      });
      job.filePath = result.filePath;
      job.speed = null;
      job.eta = null;

      // 後処理（高画質化）。失敗してもダウンロード自体は成功なので、
      // 元ファイルは残したまま警告だけ添える
      const preset = settings.get().postProcess;
      if (preset && preset !== 'none' && job.filePath) {
        job.status = 'enhancing';
        job.progress = 0;
        this.emitUpdate(job);
        try {
          const enhanced = await postprocess.process(job.filePath, {
            duration: job.duration,
            signal: job.controller.signal,
            onProgress: (p) => {
              if (typeof p.percent === 'number') job.progress = p.percent;
              if (p.speed) job.encodeSpeed = p.speed;
              this.emitUpdate(job);
            }
          });
          if (enhanced) {
            job.sourcePath = job.filePath;
            job.filePath = enhanced;
          }
        } catch (err) {
          if (err && err.canceled) throw err;
          job.postProcessError = err.message;
        }
      }

      job.status = 'completed';
      job.progress = 100;
    } catch (err) {
      job.status = err && err.canceled ? 'canceled' : 'error';
      job.error = err ? err.message : String(err);
      job.detail = err && err.detail ? err.detail : null;
    } finally {
      job.controller = null;
      this.running.delete(job.id);
      cookies.remove(job.cookieFile);
      job.cookieFile = null;
      this.emitUpdate(job);
      this.pump();
    }
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.controller) {
      job.controller.abort();
      return true;
    }
    if (job.status === 'queued' || job.status === 'interrupted') {
      job.status = 'canceled';
      this.emitUpdate(job);
      return true;
    }
    return false;
  }

  retry(id) {
    const job = this.jobs.get(id);
    if (!job || this.running.has(id)) return false;
    // 完了済みを取り直す場合、前回の後処理の痕跡は消しておく
    job.postProcessError = null;
    job.sourcePath = null;
    job.status = 'queued';
    job.progress = 0;
    job.error = null;
    this.emitUpdate(job);
    this.pump();
    return true;
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.controller) job.controller.abort();
    cookies.remove(job.cookieFile);
    this.jobs.delete(id);
    this.emit('removed', id);
    this.saveNow();
    this.pump();
    return true;
  }

  clearFinished() {
    for (const [id, job] of [...this.jobs]) {
      if (!ACTIVE_STATUSES.includes(job.status)) {
        this.jobs.delete(id);
        this.emit('removed', id);
      }
    }
    this.saveNow();
  }
}

const instance = new Queue();
// クラス側も出しておく。テストで独立したインスタンスを作れるようにするため
instance.Queue = Queue;
instance.ACTIVE_STATUSES = ACTIVE_STATUSES;
module.exports = instance;
