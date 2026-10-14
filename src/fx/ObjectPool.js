/**
 * 对象池：预先创建好对象，用 get() 取、release() 还。
 * 爆炸粒子、警车、民用车都走对象池，避免频繁 new/GC 导致移动端掉帧。
 */
export class ObjectPool {
  constructor(factory, size, { grow = false } = {}) {
    this.factory = factory;
    this.grow = grow;
    this.free = [];
    for (let i = 0; i < size; i++) this.free.push(factory());
  }
  get() {
    return this.free.pop() ?? (this.grow ? this.factory() : null);
  }
  release(obj) {
    this.free.push(obj);
  }
}
