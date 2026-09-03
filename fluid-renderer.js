const VERTEX_SHADER = `#version 300 es
out vec2 vUv;

void main() {
  vec2 position = gl_VertexID == 0 ? vec2(-1.0, -1.0) :
                  gl_VertexID == 1 ? vec2(3.0, -1.0) : vec2(-1.0, 3.0);
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp usampler2D;

uniform usampler2D uState;
uniform ivec2 uGridSize;
uniform vec3 uPalette[24];
uniform int uHoveredOwner;
uniform float uTime;

in vec2 vUv;
out vec4 outColor;

float cubicWeight(float distance) {
  float value = abs(distance);
  if (value < 1.0) return (4.0 - 6.0 * value * value + 3.0 * value * value * value) / 6.0;
  if (value < 2.0) return pow(2.0 - value, 3.0) / 6.0;
  return 0.0;
}

float transitionProgress(float progress) {
  if (progress < 0.65) {
    float phase = smoothstep(0.0, 1.0, progress / 0.65);
    return phase * 0.78;
  }
  if (progress < 0.82) {
    float phase = smoothstep(0.0, 1.0, (progress - 0.65) / 0.17);
    return mix(0.78, 0.68, phase);
  }
  float phase = smoothstep(0.0, 1.0, (progress - 0.82) / 0.18);
  return mix(0.68, 1.0, phase);
}

void main() {
  vec2 sourceUv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 gridPosition = sourceUv * vec2(uGridSize) - 0.5;

  float influence[24];
  for (int owner = 0; owner < 24; owner++) influence[owner] = 0.0;
  float activity = 0.0;

  ivec2 origin = ivec2(floor(gridPosition));
  for (int y = -1; y <= 2; y++) {
    for (int x = -1; x <= 2; x++) {
      ivec2 samplePosition = origin + ivec2(x, y);
      ivec2 cell = clamp(samplePosition, ivec2(0), uGridSize - 1);
      vec2 offset = vec2(samplePosition) - gridPosition;
      float weight = cubicWeight(offset.x) * cubicWeight(offset.y);
      uvec4 state = texelFetch(uState, cell, 0);
      int previousOwner = int(state.r);
      int currentOwner = int(state.g);
      float progress = float(state.b) / 255.0;
      float eased = transitionProgress(progress);
      influence[previousOwner] += weight * (1.0 - eased);
      influence[currentOwner] += weight * eased;
      activity += weight * float(state.a) / 255.0;
    }
  }

  int strongestOwner = 0;
  float strongest = -1.0;
  float runnerUp = -1.0;
  for (int owner = 0; owner < 24; owner++) {
    float value = influence[owner];
    if (value > strongest) {
      runnerUp = strongest;
      strongest = value;
      strongestOwner = owner;
    } else if (value > runnerUp) {
      runnerUp = value;
    }
  }

  float margin = strongest - runnerUp;
  float pixelDistance = margin / max(fwidth(margin), 0.0001);
  float core = 1.0 - smoothstep(0.0, 0.8, pixelDistance);
  float capture = smoothstep(0.03, 0.35, activity);
  float railWidth = 4.4 + capture * 4.0;
  float rail = smoothstep(0.55, 1.15, pixelDistance) *
               (1.0 - smoothstep(railWidth - 1.0, railWidth, pixelDistance));
  float halo = smoothstep(1.0, 2.0, pixelDistance) *
               (1.0 - smoothstep(railWidth + 4.0, railWidth + 8.0, pixelDistance));
  float waveA = 0.5 + 0.5 * sin(gl_FragCoord.x * 0.065 + gl_FragCoord.y * 0.047 - uTime * 12.0);
  float waveB = 0.5 + 0.5 * sin(gl_FragCoord.x * 0.035 - gl_FragCoord.y * 0.072 + uTime * 8.0);
  float pulse = max(smoothstep(0.55, 0.94, waveA), smoothstep(0.82, 0.99, waveB));
  float spark = pow(0.5 + 0.5 * sin(gl_FragCoord.x * 0.19 - gl_FragCoord.y * 0.13 + uTime * 22.0), 18.0);
  float energy = rail * (0.28 + pulse * 0.58 + capture * 0.28 + spark * capture * 0.38);
  vec3 base = uPalette[strongestOwner];
  vec3 color = base * (1.0 - core * 0.22);
  vec3 glow = min(base * 1.45 + 0.05, vec3(1.0));
  color = mix(color, glow, halo * (0.12 + capture * 0.32));
  vec3 frontier = mix(min(base * 1.7 + 0.06, vec3(1.0)), vec3(1.0), pulse * (0.25 + capture * 0.45));
  color = mix(color, frontier, min(energy, 1.0));

  if (uHoveredOwner >= 0) {
    color *= strongestOwner == uHoveredOwner ? 1.06 : 0.92;
  }

  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const message = gl.getShaderInfoLog(shader);
  gl.deleteShader(shader);
  throw new Error(message);
}

function makeProgram(gl) {
  const program = gl.createProgram();
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  const message = gl.getProgramInfoLog(program);
  gl.deleteProgram(program);
  throw new Error(message);
}

function paletteData(colors) {
  return new Float32Array(colors.flatMap((color) => {
    const value = Number.parseInt(color.slice(1), 16);
    return [(value >> 16) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
  }));
}

export class FluidRenderer {
  constructor(canvas, colors) {
    this.canvas = canvas;
    this.available = false;
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.transitionDuration = 0.42;

    try {
      const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
      if (!gl) return;
      this.gl = gl;
      this.program = makeProgram(gl);
      this.texture = gl.createTexture();
      this.vertexArray = gl.createVertexArray();
      this.locations = {
        state: gl.getUniformLocation(this.program, "uState"),
        gridSize: gl.getUniformLocation(this.program, "uGridSize"),
        palette: gl.getUniformLocation(this.program, "uPalette[0]"),
        hoveredOwner: gl.getUniformLocation(this.program, "uHoveredOwner"),
        time: gl.getUniformLocation(this.program, "uTime")
      };

      gl.useProgram(this.program);
      gl.uniform1i(this.locations.state, 0);
      gl.uniform3fv(this.locations.palette, paletteData(colors));
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      this.available = true;
    } catch (error) {
      console.warn("WebGL territory renderer unavailable", error);
    }
  }

  reset(world) {
    const length = world.cells.length;
    this.previousOwners = Uint8Array.from(world.cells);
    this.currentOwners = Uint8Array.from(world.cells);
    this.transitionStarts = new Float64Array(length);
    this.transitionStarts.fill(-Infinity);
    this.state = new Uint8Array(length * 4);
    this.textureWidth = 0;
    this.textureHeight = 0;
  }

  updateState(world, now) {
    if (!this.state || this.currentOwners.length !== world.cells.length) this.reset(world);
    for (let index = 0; index < world.cells.length; index += 1) {
      const nextOwner = world.cells[index];
      if (nextOwner !== this.currentOwners[index]) {
        const priorProgress = (now - this.transitionStarts[index]) / this.transitionDuration;
        if (priorProgress >= 0.5) this.previousOwners[index] = this.currentOwners[index];
        this.currentOwners[index] = nextOwner;
        this.transitionStarts[index] = now;
      }

      const progress = Math.min(1, (now - this.transitionStarts[index]) / this.transitionDuration);
      const offset = index * 4;
      if (progress >= 1) this.previousOwners[index] = this.currentOwners[index];
      this.state[offset] = this.previousOwners[index];
      this.state[offset + 1] = this.currentOwners[index];
      this.state[offset + 2] = Math.round(Math.max(0, progress) * 255);
      this.state[offset + 3] = progress >= 1 ? 0 : Math.round(Math.sin(Math.max(0, progress) * Math.PI) * 255);
    }
  }

  render(world, hoveredOwner, now) {
    if (!this.available) return;
    const gl = this.gl;
    this.updateState(world, now);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const width = Math.floor(world.width * dpr);
    const height = Math.floor(world.height * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.canvas.style.width = `${world.width}px`;
      this.canvas.style.height = `${world.height}px`;
      gl.viewport(0, 0, width, height);
    }

    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.textureWidth !== world.cols || this.textureHeight !== world.rows) {
      this.textureWidth = world.cols;
      this.textureHeight = world.rows;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, world.cols, world.rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, this.state);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, world.cols, world.rows, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, this.state);
    }

    gl.uniform2i(this.locations.gridSize, world.cols, world.rows);
    gl.uniform1i(this.locations.hoveredOwner, hoveredOwner);
    gl.uniform1f(this.locations.time, now);
    gl.bindVertexArray(this.vertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
