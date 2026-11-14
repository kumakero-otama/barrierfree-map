// 再取得できる検索結果専用。DB・記録・監査には使用しない。
// JSONサイズはJSヒープ実測ではないため、余裕を持った小さい上限を設定する。
class BoundedCache extends Map {
  constructor({ maxEntries = 64, maxBytes = 8 * 1024 * 1024, ttlMs = 300000, now = Date.now } = {}) {
    super(); this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    this.ttlMs = ttlMs; this.now = now; this.metadata = new Map(); this.byteSize = 0;
    const timer = setInterval(() => this.sweep(), Math.min(ttlMs, 60000));
    timer.unref();
  }
  delete(key) {
    const metadata = this.metadata.get(key);
    if (metadata) this.byteSize -= metadata.bytes;
    this.metadata.delete(key); return super.delete(key);
  }
  clear() { super.clear(); this.metadata.clear(); this.byteSize = 0; }
  sweep() {
    const now = this.now();
    for (const [key, metadata] of this.metadata) if (metadata.expiresAt <= now) this.delete(key);
  }
  get(key) {
    const metadata = this.metadata.get(key);
    if (!metadata) return undefined;
    if (metadata.expiresAt <= this.now()) { this.delete(key); return undefined; }
    const value = super.get(key);
    super.delete(key); super.set(key, value); return value;
  }
  set(key, value) {
    this.delete(key); this.sweep();
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch (_) { return this; }
    if (bytes > this.maxBytes || this.maxEntries < 1) return this;
    while (this.size && (this.size >= this.maxEntries || this.byteSize + bytes > this.maxBytes)) {
      this.delete(this.keys().next().value);
    }
    super.set(key, value); this.metadata.set(key, { bytes, expiresAt: this.now() + this.ttlMs });
    this.byteSize += bytes; return this;
  }
}
module.exports = { BoundedCache };
