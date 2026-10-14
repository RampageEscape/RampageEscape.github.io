const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const keys = {};
addEventListener('keydown', e => keys[e.key] = true);
addEventListener('keyup', e => keys[e.key] = false);

const player = { x: 400, y: 300, size: 30, speed: 250 };

function update(dt) {
  if (keys.ArrowLeft || keys.a) player.x -= player.speed * dt;
  if (keys.ArrowRight || keys.d) player.x += player.speed * dt;
  if (keys.ArrowUp || keys.w) player.y -= player.speed * dt;
  if (keys.ArrowDown || keys.s) player.y += player.speed * dt;
  player.x = Math.max(0, Math.min(canvas.width - player.size, player.x));
  player.y = Math.max(0, Math.min(canvas.height - player.size, player.y));
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#4fc3f7';
  ctx.fillRect(player.x, player.y, player.size, player.size);
  ctx.fillStyle = '#aaa';
  ctx.font = '16px sans-serif';
  ctx.fillText('用方向键或 WASD 移动', 10, 24);
}

let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
