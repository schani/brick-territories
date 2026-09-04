# Brick Territories

An animated territory simulation driven by bouncing balls. Each ball captures cells for its territory and moves at an individually sampled speed.

![Brick Territories](docs/screenshot.png)

## Features

- Smooth WebGL territories with animated frontiers
- Canvas brick renderer fallback
- Normally distributed ball speeds
- Hover details and area history
- Adjustable territory count, cell size, speed, ball size, and seed

## Run locally

```sh
npm install
npm run dev
```

Create a production build with `npm run build`.

## Publish to Hostr

```sh
HOSTR_TOKEN=your-token npm run publish
```

Pass an optional destination path with `npm run publish -- my-path`.

## Inspiration

Based on [jagarikin's original post](https://twitter.com/jagarikin/status/1388660839205326851).
