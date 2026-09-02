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

uniform usampler2D uOwners;
uniform ivec2 uGridSize;
uniform vec3 uPalette[24];
uniform int uHoveredOwner;

in vec2 vUv;
out vec4 outColor;

float grain(vec2 point) {
  return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
}

float cubicWeight(float distance) {
  float value = abs(distance);
  if (value < 1.0) return (4.0 - 6.0 * value * value + 3.0 * value * value * value) / 6.0;
  if (value < 2.0) return pow(2.0 - value, 3.0) / 6.0;
  return 0.0;
}

void main() {
  vec2 sourceUv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 gridPosition = sourceUv * vec2(uGridSize) - 0.5;

  float influence[24];
  for (int owner = 0; owner < 24; owner++) influence[owner] = 0.0;

  ivec2 origin = ivec2(floor(gridPosition));
  for (int y = -1; y <= 2; y++) {
    for (int x = -1; x <= 2; x++) {
      ivec2 samplePosition = origin + ivec2(x, y);
      ivec2 cell = clamp(samplePosition, ivec2(0), uGridSize - 1);
      vec2 offset = vec2(samplePosition) - gridPosition;
      float weight = cubicWeight(offset.x) * cubicWeight(offset.y);
      int owner = int(texelFetch(uOwners, cell, 0).r);
      influence[owner] += weight;
    }
  }

  int strongestOwner = 0;
  int runnerUpOwner = 0;
  float strongest = -1.0;
  float runnerUp = -1.0;
  for (int owner = 0; owner < 24; owner++) {
    float value = influence[owner];
    if (value > strongest) {
      runnerUp = strongest;
      runnerUpOwner = strongestOwner;
      strongest = value;
      strongestOwner = owner;
    } else if (value > runnerUp) {
      runnerUp = value;
      runnerUpOwner = owner;
    }
  }

  float margin = strongest - runnerUp;
  float antialiasWidth = max(fwidth(margin) * 1.45, 0.002);
  float boundary = 1.0 - smoothstep(0.0, antialiasWidth, margin);
  vec3 color = mix(uPalette[strongestOwner], uPalette[runnerUpOwner], boundary * 0.46);
  color = mix(color, vec3(0.09), boundary * 0.07);

  if (uHoveredOwner >= 0) {
    color *= strongestOwner == uHoveredOwner ? 1.06 : 0.92;
  }

  color += (grain(gl_FragCoord.xy) - 0.5) * 0.018;
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

    try {
      const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
      if (!gl) return;
      this.gl = gl;
      this.program = makeProgram(gl);
      this.texture = gl.createTexture();
      this.vertexArray = gl.createVertexArray();
      this.locations = {
        owners: gl.getUniformLocation(this.program, "uOwners"),
        gridSize: gl.getUniformLocation(this.program, "uGridSize"),
        palette: gl.getUniformLocation(this.program, "uPalette[0]"),
        hoveredOwner: gl.getUniformLocation(this.program, "uHoveredOwner")
      };

      gl.useProgram(this.program);
      gl.uniform1i(this.locations.owners, 0);
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

  render(world, hoveredOwner) {
    if (!this.available) return;
    const gl = this.gl;
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
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, world.cols, world.rows, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, world.cells);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, world.cols, world.rows, gl.RED_INTEGER, gl.UNSIGNED_BYTE, world.cells);
    }

    gl.uniform2i(this.locations.gridSize, world.cols, world.rows);
    gl.uniform1i(this.locations.hoveredOwner, hoveredOwner);
    gl.bindVertexArray(this.vertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
