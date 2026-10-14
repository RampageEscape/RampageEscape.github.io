import * as THREE from 'three';
import { Road } from '../world/Road.js';

// 用 canvas 画一个“红色三角 + 白色感叹号”的贴图，不需要额外图片资源
function makeSignTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#ff2a2a';
  g.strokeStyle = '#ffffff';
  g.lineWidth = 8;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(64, 10);
  g.lineTo(120, 112);
  g.lineTo(8, 112);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = '#ffffff';
  g.font = 'bold 68px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('!', 64, 78);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 路障前方地面上的红色感叹号预警（只画在被堵住的车道上），统一闪烁 */
export class RoadWarnings {
  constructor(scene) {
    this.scene = scene;
    this.geo = new THREE.PlaneGeometry(2.8, 2.8).rotateX(-Math.PI / 2);
    this.mat = new THREE.MeshBasicMaterial({ map: makeSignTexture(), transparent: true, depthWrite: false });
    this.free = [];
    this.t = 0;
  }

  place(z, lateral) {
    let m = this.free.pop();
    if (!m) {
      m = new THREE.Mesh(this.geo, this.mat);
      this.scene.add(m);
    }
    m.position.set(Road.centerX(z) + lateral, 0.07, z);
    m.rotation.y = Road.heading(z) + Math.PI; // 让三角形尖端朝前方（屏幕上方）
    m.visible = true;
    return m;
  }

  release(m) {
    m.visible = false;
    this.free.push(m);
  }

  update(dt) {
    this.t += dt;
    this.mat.opacity = 0.55 + 0.45 * Math.abs(Math.sin(this.t * 5));
  }
}
