import * as THREE from 'three';

/** 雪花：一团跟着镜头走的点精灵，只在森林段显示 */
export class Snow {
  constructor(scene, count = 700) {
    this.box = { w: 90, h: 30, d: 90 };
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this.box.w;
      pos[i * 3 + 1] = Math.random() * this.box.h;
      pos[i * 3 + 2] = (Math.random() - 0.5) * this.box.d;
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.mat = new THREE.PointsMaterial({ color: 0xffffff, size: 3, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.t = 0;
  }

  update(dt, center, weight) {
    this.mat.opacity = 0.9 * weight;
    this.points.visible = weight > 0.01;
    if (!this.points.visible) return;
    this.t += dt;
    this.points.position.set(center.x, 0, center.z);
    const a = this.geo.attributes.position, arr = a.array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i + 1] -= (4 + (i % 7)) * dt;
      arr[i] += Math.sin(this.t + i) * dt * 0.8;
      if (arr[i + 1] < 0) arr[i + 1] += this.box.h;
    }
    a.needsUpdate = true;
  }
}
