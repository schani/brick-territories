import { FluidRenderer } from "./fluid-renderer.js";
import { TerritoryAudio } from "./audio-engine.js";

const COLORS = [
  "#e05b43", "#2459a6", "#e6b82e", "#479967", "#8a64a7", "#dd7834",
  "#299a9b", "#bd4968", "#71843a", "#545c92", "#c93f32", "#3874b8",
  "#d69c22", "#2f7b59", "#a75183", "#c5673d", "#397f89", "#d06177",
  "#8d8731", "#65519a", "#a94f27", "#4f8a70", "#9c3f57", "#6e7738"
];

const $ = (selector) => document.querySelector(selector);
const canvas = $("#world");
const fluidCanvas = $("#fluid-world");
const frame = $(".world-frame");
const controls = $("#controls");
const ctx = canvas.getContext("2d", { alpha: false });
const chart = $("#stats-chart");
const chartCtx = chart.getContext("2d");

function seededRandom(seed) {
  let state = seed | 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function normalRandom(random) {
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function readSettings() {
  return {
    territories: Number(controls.territories.value),
    brick: Number(controls.brick.value),
    speed: Number(controls.speed.value),
    ball: Number(controls.ball.value),
    seed: Number(controls.seed.value)
  };
}

function spreadPoints(count, cols, rows, random) {
  const points = [];
  for (let index = 0; index < count; index += 1) {
    let winner = null;
    let winnerDistance = -1;
    const attempts = index ? 36 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const candidate = {
        x: 1.5 + random() * Math.max(1, cols - 3),
        y: 1.5 + random() * Math.max(1, rows - 3)
      };
      const nearest = points.reduce((distance, point) => Math.min(distance, Math.hypot(point.x - candidate.x, point.y - candidate.y)), Infinity);
      if (nearest > winnerDistance) {
        winner = candidate;
        winnerDistance = nearest;
      }
    }
    points.push(winner);
  }
  return points;
}

class TerritoryWorld {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.cols = 0;
    this.rows = 0;
    this.cellWidth = 0;
    this.cellHeight = 0;
    this.cells = new Uint8Array();
    this.balls = [];
    this.captureEvents = [];
    this.hoveredCell = -1;
    this.settings = readSettings();
  }

  reset() {
    this.settings = readSettings();
    this.width = Math.max(1, Math.floor(frame.clientWidth));
    this.height = Math.max(1, Math.floor(frame.clientHeight));
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.floor(this.width * dpr);
    canvas.height = Math.floor(this.height * dpr);
    canvas.style.width = `${this.width}px`;
    canvas.style.height = `${this.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.cols = Math.max(12, Math.floor(this.width / this.settings.brick));
    this.rows = Math.max(12, Math.floor(this.height / this.settings.brick));
    this.cellWidth = this.width / this.cols;
    this.cellHeight = this.height / this.rows;

    const random = seededRandom(this.settings.seed);
    const points = spreadPoints(this.settings.territories, this.cols, this.rows, random);
    this.cells = new Uint8Array(this.cols * this.rows);
    this.captureEvents = [];

    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        let nearest = Infinity;
        for (let owner = 0; owner < points.length; owner += 1) {
          const distance = (col + 0.5 - points[owner].x) ** 2 + (row + 0.5 - points[owner].y) ** 2;
          if (distance < nearest) {
            nearest = distance;
            this.cells[row * this.cols + col] = owner;
          }
        }
      }
    }

    this.balls = points.map((point, owner) => {
      const direction = random() * Math.PI * 2;
      const meanVelocity = this.settings.brick * 20.375 * this.settings.speed;
      const velocity = Math.max(meanVelocity * 0.35, meanVelocity * (1 + normalRandom(random) * 0.35));
      return {
        owner,
        x: (point.x + 0.5) * this.cellWidth,
        y: (point.y + 0.5) * this.cellHeight,
        vx: Math.cos(direction) * velocity,
        vy: Math.sin(direction) * velocity,
        radius: Math.min(this.cellWidth, this.cellHeight) * this.settings.ball,
        lastClaim: -1
      };
    });
  }

  indexAt(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return Math.floor(y / this.cellHeight) * this.cols + Math.floor(x / this.cellWidth);
  }

  ownerNear(index, attacker) {
    if (index < 0) return true;
    const col = index % this.cols;
    const row = Math.floor(index / this.cols);
    return this.balls.some((ball) => {
      if (ball.owner === attacker) return false;
      const ballCol = Math.floor(ball.x / this.cellWidth);
      const ballRow = Math.floor(ball.y / this.cellHeight);
      return Math.abs(ballCol - col) <= 1 && Math.abs(ballRow - row) <= 1;
    });
  }

  collision(ball, x, y) {
    const radius = Math.min(ball.radius, Math.min(this.cellWidth, this.cellHeight) * 0.42);
    const hits = [];
    for (let step = 0; step < 16; step += 1) {
      const angle = step / 16 * Math.PI * 2;
      const nx = Math.cos(angle);
      const ny = Math.sin(angle);
      const index = this.indexAt(x + nx * radius, y + ny * radius);
      if (index < 0 || this.cells[index] !== ball.owner) hits.push({ index, nx, ny, approach: nx * ball.vx + ny * ball.vy });
    }
    if (!hits.length) return null;
    const approaching = hits.filter((hit) => hit.approach > 0);
    const surface = approaching.length ? approaching : hits;
    const normal = surface.reduce((sum, hit) => ({ x: sum.x + hit.nx, y: sum.y + hit.ny }), { x: 0, y: 0 });
    const length = Math.hypot(normal.x, normal.y) || 1;
    const target = hits.reduce((best, hit) => hit.approach > best.approach ? hit : best, hits[0]);
    return { index: target.index, nx: normal.x / length, ny: normal.y / length };
  }

  escapeAngle(ball, reflected, distance) {
    for (let turn = 0; turn <= 18; turn += 1) {
      const offsets = turn ? [turn, -turn] : [0];
      for (const offset of offsets) {
        const angle = reflected + offset * Math.PI / 18;
        if (!this.collision(ball, ball.x + Math.cos(angle) * distance, ball.y + Math.sin(angle) * distance)) return angle;
      }
    }
    return reflected + Math.PI * 0.618;
  }

  move(ball, seconds) {
    const nextX = ball.x + ball.vx * seconds;
    const nextY = ball.y + ball.vy * seconds;
    const hit = this.collision(ball, nextX, nextY);
    if (!hit) {
      ball.x = nextX;
      ball.y = nextY;
      return;
    }

    if (hit.index >= 0 && hit.index !== ball.lastClaim && !this.ownerNear(hit.index, ball.owner)) {
      this.cells[hit.index] = ball.owner;
      ball.lastClaim = hit.index;
      if (this.captureEvents.length < 64) {
        const col = hit.index % this.cols;
        const row = Math.floor(hit.index / this.cols);
        this.captureEvents.push({
          owner: ball.owner,
          x: (col + 0.5) / this.cols,
          y: (row + 0.5) / this.rows
        });
      }
    }

    const speed = Math.hypot(ball.vx, ball.vy);
    const dot = ball.vx * hit.nx + ball.vy * hit.ny;
    const reflected = Math.atan2(ball.vy - 2 * dot * hit.ny, ball.vx - 2 * dot * hit.nx);
    const probe = Math.max(1.5, Math.min(this.cellWidth, this.cellHeight) * 0.16);
    const angle = this.escapeAngle(ball, reflected, probe);
    ball.vx = Math.cos(angle) * speed;
    ball.vy = Math.sin(angle) * speed;

    const escapeX = ball.x + Math.cos(angle) * probe;
    const escapeY = ball.y + Math.sin(angle) * probe;
    if (!this.collision(ball, escapeX, escapeY)) {
      ball.x = escapeX;
      ball.y = escapeY;
    }
  }

  update(seconds) {
    this.captureEvents = [];
    let remaining = seconds;
    while (remaining > 0) {
      const step = Math.min(1 / 120, remaining);
      for (const ball of this.balls) this.move(ball, step);
      remaining -= step;
    }
    return this.captureEvents;
  }

  counts() {
    const result = new Uint32Array(this.settings.territories);
    for (const owner of this.cells) result[owner] += 1;
    return result;
  }

  draw(showBalls = true) {
    ctx.fillStyle = "#d8d4ca";
    ctx.fillRect(0, 0, this.width, this.height);
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        ctx.fillStyle = COLORS[this.cells[row * this.cols + col]];
        ctx.fillRect(col * this.cellWidth + 0.45, row * this.cellHeight + 0.45, this.cellWidth - 0.9, this.cellHeight - 0.9);
      }
    }

    if (showBalls) {
      for (const ball of this.balls) {
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
        ctx.fillStyle = "#f4f1e9";
        ctx.fill();
        ctx.lineWidth = Math.max(1.25, ball.radius * 0.12);
        ctx.strokeStyle = "#171713";
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ball.x - ball.radius * 0.26, ball.y - ball.radius * 0.28, ball.radius * 0.16, 0, Math.PI * 2);
        ctx.fillStyle = COLORS[ball.owner];
        ctx.fill();
      }
    }

    if (this.hoveredCell >= 0) {
      const col = this.hoveredCell % this.cols;
      const row = Math.floor(this.hoveredCell / this.cols);
      const x = col * this.cellWidth;
      const y = row * this.cellHeight;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#f4f1e9";
      ctx.strokeRect(x + 1.5, y + 1.5, this.cellWidth - 3, this.cellHeight - 3);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#171713";
      ctx.strokeRect(x + 2.5, y + 2.5, this.cellWidth - 5, this.cellHeight - 5);
    }
  }
}

class AreaHistory {
  constructor(world) {
    this.world = world;
    this.samples = [];
    this.latest = new Uint32Array();
    this.hovered = -1;
  }

  reset() {
    this.samples = [];
    this.hovered = -1;
    $("#stats-list").replaceChildren();
    for (let owner = 0; owner < this.world.settings.territories; owner += 1) {
      const row = document.createElement("div");
      row.className = "stats-row";
      row.dataset.owner = owner;
      row.innerHTML = `<i class="stats-swatch"></i><span class="stats-name">Territory ${owner + 1}</span><span class="stats-speed">speed 0.00×</span><span class="stats-count">0</span><span class="stats-percent">0.0%</span>`;
      row.querySelector("i").style.background = COLORS[owner];
      row.addEventListener("pointerenter", () => this.highlight(owner));
      row.addEventListener("pointerleave", () => this.highlight(-1));
      $("#stats-list").append(row);
    }
    this.sample();
  }

  sample() {
    this.latest = this.world.counts();
    this.samples.push(Float32Array.from(this.latest));
    if (this.samples.length > 1000) this.samples = this.samples.filter((_, index) => index % 2 === 1);
    this.updateList();
    if (!$("#stats-panel").hidden) this.draw();
  }

  updateList() {
    const total = this.world.cells.length;
    const list = $("#stats-list");
    const rows = [...list.children];
    for (const row of rows) {
      const owner = Number(row.dataset.owner);
      const ball = this.world.balls[owner];
      const speed = Math.hypot(ball.vx, ball.vy) / (this.world.settings.brick * 20.375);
      row.querySelector(".stats-speed").textContent = `speed ${speed.toFixed(2)}×`;
      row.querySelector(".stats-count").textContent = this.latest[owner].toLocaleString();
      row.querySelector(".stats-percent").textContent = `${(this.latest[owner] / total * 100).toFixed(1)}%`;
    }
    rows.sort((first, second) => {
      const firstOwner = Number(first.dataset.owner);
      const secondOwner = Number(second.dataset.owner);
      return this.latest[secondOwner] - this.latest[firstOwner] || firstOwner - secondOwner;
    });
    list.append(...rows);
  }

  highlight(owner) {
    this.hovered = owner;
    for (const row of $("#stats-list").children) row.classList.toggle("active", Number(row.dataset.owner) === owner);
    this.draw();
  }

  draw() {
    if ($("#stats-panel").hidden || !this.samples.length) return;
    const bounds = chart.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(bounds.width));
    const height = Math.max(1, Math.floor(bounds.height));
    chart.width = Math.floor(width * dpr);
    chart.height = Math.floor(height * dpr);
    chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    chartCtx.clearRect(0, 0, width, height);

    const left = 38;
    const right = width - 1;
    const top = 14;
    const bottom = height - 14;
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const sample of this.samples) {
      for (const count of sample) {
        minimum = Math.min(minimum, count);
        maximum = Math.max(maximum, count);
      }
    }
    const span = Math.max(2, maximum - minimum);
    minimum = Math.max(0, minimum - span * 0.12);
    maximum += span * 0.12;

    chartCtx.strokeStyle = "rgba(23, 23, 19, 0.12)";
    chartCtx.lineWidth = 1;
    for (let part = 1; part < 4; part += 1) {
      const y = top + (bottom - top) * part / 4;
      chartCtx.beginPath();
      chartCtx.moveTo(left, y);
      chartCtx.lineTo(right, y);
      chartCtx.stroke();
    }

    const total = this.world.cells.length;
    chartCtx.fillStyle = "rgba(23, 23, 19, 0.58)";
    chartCtx.font = "10px Arial";
    chartCtx.fillText(`${Math.round(maximum / total * 100)}%`, 1, top + 3);
    chartCtx.fillText(`${Math.round(minimum / total * 100)}%`, 1, bottom);

    const owners = Array.from({ length: this.world.settings.territories }, (_, owner) => owner);
    if (this.hovered >= 0) owners.push(owners.splice(owners.indexOf(this.hovered), 1)[0]);
    const xFor = (index) => this.samples.length === 1 ? left : left + index / (this.samples.length - 1) * (right - left);
    const yFor = (value) => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);
    for (const owner of owners) {
      chartCtx.beginPath();
      this.samples.forEach((sample, index) => {
        const x = xFor(index);
        const y = yFor(sample[owner]);
        if (index) chartCtx.lineTo(x, y);
        else chartCtx.moveTo(x, y);
      });
      const active = owner === this.hovered;
      chartCtx.globalAlpha = this.hovered < 0 || active ? 0.95 : 0.42;
      chartCtx.strokeStyle = COLORS[owner];
      chartCtx.lineWidth = active ? 3.5 : 1.5;
      chartCtx.lineJoin = "round";
      chartCtx.stroke();
    }
    chartCtx.globalAlpha = 1;
  }
}

const world = new TerritoryWorld();
const history = new AreaHistory(world);
const fluidRenderer = new FluidRenderer(fluidCanvas, COLORS);
const audio = new TerritoryAudio();
let paused = false;
let elapsedSeconds = 0;
let visualSeconds = 0;
let previousTime = performance.now();
let nextSample = 0.25;
let observedWidth = 0;
let resizeTimer;
let hoverPosition = null;
let tooltipContent = "";
let webglEnabled = fluidRenderer.available;

function formatElapsed(seconds) {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

function setPaused(next) {
  paused = next;
  $("#pause").classList.toggle("paused", paused);
  $("#pause-label").textContent = paused ? "resume" : "pause";
  $("#pause").setAttribute("aria-label", paused ? "Resume simulation" : "Pause simulation");
  $("#status-text").textContent = paused ? "paused" : webglEnabled ? "WebGL" : "running";
  $("#status-dot").classList.toggle("paused", paused);
  $("#status-dot").classList.toggle("webgl", webglEnabled && !paused);
  audio.setPaused(paused);
  previousTime = performance.now();
}

function reset() {
  hideCellTooltip();
  world.reset();
  fluidRenderer.reset(world);
  audio.reset(world);
  visualSeconds = 0;
  renderWorld();
  observedWidth = world.width;
  elapsedSeconds = 0;
  nextSample = 0.25;
  $("#elapsed").textContent = "00:00";
  history.reset();
  setPaused(false);
}

function renderWorld(time = visualSeconds) {
  canvas.hidden = webglEnabled;
  fluidCanvas.hidden = !webglEnabled;
  if (!webglEnabled) {
    world.draw();
    return;
  }
  const hoveredOwner = world.hoveredCell < 0 ? -1 : world.cells[world.hoveredCell];
  fluidRenderer.render(world, hoveredOwner, time);
}

function hideCellTooltip() {
  hoverPosition = null;
  tooltipContent = "";
  world.hoveredCell = -1;
  $("#cell-tooltip").hidden = true;
}

function updateCellTooltip() {
  if (!hoverPosition || world.hoveredCell < 0) return;
  const owner = world.cells[world.hoveredCell];
  const count = history.latest[owner] ?? world.counts()[owner];
  const area = `${(count / world.cells.length * 100).toFixed(1)}%`;
  const ball = world.balls[owner];
  const speed = Math.hypot(ball.vx, ball.vy) / (world.settings.brick * 20.375);
  const content = `${owner}:${area}:${speed.toFixed(2)}`;
  const tooltip = $("#cell-tooltip");

  if (content !== tooltipContent) {
    tooltipContent = content;
    $("#tooltip-territory").textContent = `Territory ${owner + 1}`;
    $("#tooltip-swatch").style.background = COLORS[owner];
    $("#tooltip-area").value = area;
    $("#tooltip-speed").value = speed.toFixed(2);
  }

  tooltip.hidden = false;
  const left = Math.min(frame.clientWidth - tooltip.offsetWidth - 8, hoverPosition.x + 14);
  const top = Math.min(frame.clientHeight - tooltip.offsetHeight - 8, hoverPosition.y + 14);
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function tick(now) {
  requestAnimationFrame(tick);
  const delta = (now - previousTime) / 1000;
  previousTime = now;
  if (!paused) {
    const frameDelta = Math.min(delta, 0.05);
    const simulationDelta = frameDelta * (webglEnabled ? 12 : 1);
    elapsedSeconds += simulationDelta;
    visualSeconds += frameDelta;
    const captures = world.update(simulationDelta);
    try {
      audio.update(world, captures);
    } catch (error) {
      console.warn("Audio synthesis stopped", error);
      $("#audio-mode").value = "off";
      $(".grain-source-control").hidden = true;
      audio.stop();
    }
    renderWorld();
    updateCellTooltip();
    if (elapsedSeconds >= nextSample) {
      history.sample();
      nextSample = Math.floor(elapsedSeconds / 0.25 + 1) * 0.25;
    }
    $("#elapsed").textContent = formatElapsed(elapsedSeconds);
  }
}

function updateOutputs() {
  for (const name of ["territories", "brick", "speed", "ball", "seed"]) {
    const value = Number(controls[name].value);
    $(`#${name}-value`).value = name === "speed" ? value.toFixed(1) : controls[name].value;
  }
}

controls.addEventListener("input", (event) => {
  updateOutputs();
  if (event.target !== controls.speed || !world.balls.length) return;
  const next = Number(controls.speed.value);
  const ratio = next / world.settings.speed;
  for (const ball of world.balls) {
    ball.vx *= ratio;
    ball.vy *= ratio;
  }
  world.settings.speed = next;
});

controls.addEventListener("submit", (event) => {
  event.preventDefault();
  reset();
});

$("#pause").addEventListener("click", () => setPaused(!paused));
$("#webgl").addEventListener("change", (event) => {
  webglEnabled = event.target.checked;
  if (webglEnabled) fluidRenderer.reset(world);
  setPaused(paused);
  renderWorld();
});
const grainSourceControl = $(".grain-source-control");
const grainPresets = {
  piano: "/audio/piano.mp3",
  drums: "/audio/drums.mp3",
  rain: "/audio/rain.mp3",
  song: "/audio/full-song.mp3"
};
let activeGrainPreset = "builtin";
$("#audio-mode").addEventListener("change", async (event) => {
  grainSourceControl.hidden = !event.target.value.startsWith("grain-");
  try {
    await audio.setMode(event.target.value, world);
  } catch (error) {
    console.warn("Audio synthesis unavailable", error);
    event.target.value = "off";
    grainSourceControl.hidden = true;
    audio.stop();
  }
});
$("#grain-preset").addEventListener("change", async (event) => {
  const preset = event.target.value;
  if (preset === "upload") {
    $("#grain-source").value = "";
    $("#grain-source").click();
    return;
  }
  try {
    if (await audio.loadGrainPreset(preset, grainPresets[preset], world)) activeGrainPreset = preset;
  } catch (error) {
    console.warn("Audio source unavailable", error);
    event.target.value = activeGrainPreset;
  }
});
$("#grain-source").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  const preset = $("#grain-preset");
  if (!file) return;
  const uploadOption = preset.querySelector('[value="upload"]');
  uploadOption.textContent = "Loading…";
  try {
    if (await audio.loadGrainSource(await file.arrayBuffer(), world) === null) return;
    uploadOption.textContent = file.name;
    preset.value = "upload";
    activeGrainPreset = "upload";
  } catch (error) {
    console.warn("Audio file could not be decoded", error);
    uploadOption.textContent = "Upload file…";
    preset.value = activeGrainPreset;
  }
});
$("#grain-source").addEventListener("cancel", () => {
  $("#grain-preset").value = activeGrainPreset;
});
function moveOverWorld(event) {
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  hoverPosition = { x, y };
  world.hoveredCell = world.indexAt(x, y);
  renderWorld();
  updateCellTooltip();
}
function leaveWorld() {
  hideCellTooltip();
  renderWorld();
}
for (const surface of [canvas, fluidCanvas]) {
  surface.addEventListener("pointermove", moveOverWorld);
  surface.addEventListener("pointerleave", leaveWorld);
}
$("#stats-toggle").addEventListener("click", () => {
  const open = $("#stats-panel").hidden;
  if (open) hideCellTooltip();
  $("#stats-panel").hidden = !open;
  $("#stats-toggle").setAttribute("aria-expanded", String(open));
  if (open) history.draw();
});
$("#stats-close").addEventListener("click", () => $("#stats-toggle").click());
$("#inspiration-toggle").addEventListener("click", () => {
  const open = $("#inspiration-link").hidden;
  $("#inspiration-link").hidden = !open;
  $("#inspiration-toggle").setAttribute("aria-expanded", String(open));
});

document.addEventListener("pointerdown", (event) => {
  if (!$("#stats-panel").hidden && !$("#stats-panel").contains(event.target) && !$("#stats-toggle").contains(event.target)) $("#stats-toggle").click();
  if (!$("#inspiration-link").hidden && !$(".inspiration").contains(event.target)) $("#inspiration-toggle").click();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#inspiration-link").hidden) $("#inspiration-toggle").click();
  else if (event.key === "Escape" && !$("#stats-panel").hidden) $("#stats-toggle").click();
  else if (event.code === "Space" && !event.target.matches("button, input, select")) {
    event.preventDefault();
    setPaused(!paused);
  }
});

new ResizeObserver(([entry]) => {
  const width = Math.floor(entry.contentRect.width);
  if (Math.abs(width - observedWidth) < 2) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(reset, 80);
}).observe(frame);

if (Math.min(innerWidth, innerHeight) <= 520) {
  controls.territories.value = "7";
  controls.speed.value = "1.1";
}
const seedBytes = new Uint32Array(1);
crypto.getRandomValues(seedBytes);
controls.seed.value = String(seedBytes[0] % 999 + 1);
if (!fluidRenderer.available) {
  $("#webgl").checked = false;
  $("#webgl").disabled = true;
  $(".webgl-toggle").title = "WebGL2 is unavailable in this browser";
}
if (!audio.supported) {
  $("#audio-mode").disabled = true;
  $("#grain-preset").disabled = true;
  $("#grain-source").disabled = true;
  $(".audio-mode-control").title = "Web Audio is unavailable in this browser";
}
updateOutputs();
reset();
requestAnimationFrame(tick);
