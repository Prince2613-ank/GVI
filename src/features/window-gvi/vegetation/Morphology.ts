export interface BinaryMask {
  /** 0 or 1 per pixel, row-major. */
  data: Uint8Array;
  width: number;
  height: number;
}

function getPixel(mask: BinaryMask, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return 0;
  return mask.data[y * mask.width + x];
}

/** True 3x3 median of a binary signal is just majority vote over the 9 samples. */
export function medianFilter3x3(mask: BinaryMask): BinaryMask {
  const { width, height } = mask;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += getPixel(mask, x + dx, y + dy);
        }
      }
      out[y * width + x] = sum >= 5 ? 1 : 0;
    }
  }
  return { data: out, width, height };
}

function erode3x3(mask: BinaryMask): BinaryMask {
  const { width, height } = mask;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let allSet = true;
      for (let dy = -1; dy <= 1 && allSet; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (getPixel(mask, x + dx, y + dy) === 0) {
            allSet = false;
            break;
          }
        }
      }
      out[y * width + x] = allSet ? 1 : 0;
    }
  }
  return { data: out, width, height };
}

function dilate3x3(mask: BinaryMask): BinaryMask {
  const { width, height } = mask;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let anySet = false;
      for (let dy = -1; dy <= 1 && !anySet; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (getPixel(mask, x + dx, y + dy) === 1) {
            anySet = true;
            break;
          }
        }
      }
      out[y * width + x] = anySet ? 1 : 0;
    }
  }
  return { data: out, width, height };
}

/** Erosion then dilation — strips thin protrusions/isolated speckles without shrinking solid blobs. */
export function morphologicalOpen(mask: BinaryMask): BinaryMask {
  return dilate3x3(erode3x3(mask));
}

/** Dilation then erosion — fills small holes/gaps inside solid blobs. */
export function morphologicalClose(mask: BinaryMask): BinaryMask {
  return erode3x3(dilate3x3(mask));
}

/** Drops any 4-connected blob smaller than minSize pixels — the last pass to kill remaining green noise. */
export function removeSmallComponents(mask: BinaryMask, minSize = 20): BinaryMask {
  const { width, height, data } = mask;
  const visited = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);
  const stackX = new Int32Array(width * height);
  const stackY = new Int32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (data[idx] === 0 || visited[idx]) continue;

      let sp = 0;
      stackX[sp] = x;
      stackY[sp] = y;
      sp++;
      visited[idx] = 1;
      const componentIndices: number[] = [idx];

      while (sp > 0) {
        sp--;
        const cx = stackX[sp];
        const cy = stackY[sp];
        const neighbors: [number, number][] = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (data[nIdx] === 1 && !visited[nIdx]) {
            visited[nIdx] = 1;
            stackX[sp] = nx;
            stackY[sp] = ny;
            sp++;
            componentIndices.push(nIdx);
          }
        }
      }

      if (componentIndices.length >= minSize) {
        for (const i of componentIndices) out[i] = 1;
      }
    }
  }

  return { data: out, width, height };
}
