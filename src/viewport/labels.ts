import * as THREE from "three";

/** A canvas texture with centred text, used for plane labels and the view cube. */
export function textTexture(
  text: string,
  opts: {
    width?: number;
    height?: number;
    font?: string;
    color?: string;
    background?: string;
    border?: string;
    /** Rotate the text clockwise by this many radians (used by the view cube). */
    rotation?: number;
  } = {},
): THREE.CanvasTexture {
  const width = opts.width ?? 256;
  const height = opts.height ?? 64;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (g) {
    if (opts.background) {
      g.fillStyle = opts.background;
      g.fillRect(0, 0, width, height);
    }
    if (opts.border) {
      g.strokeStyle = opts.border;
      g.lineWidth = Math.max(4, width / 40);
      g.strokeRect(0, 0, width, height);
    }
    g.font = opts.font ?? `600 ${Math.round(height * 0.55)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.fillStyle = opts.color ?? "#333";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.translate(width / 2, height / 2);
    g.rotate(opts.rotation ?? 0);
    g.fillText(text, 0, 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** A text sprite whose on-screen size is set each frame by the viewport. */
export function labelSprite(text: string, color: string): THREE.Sprite {
  const texture = textTexture(text, { width: 256, height: 64, color });
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0, 0); // anchor at bottom-left corner
  sprite.renderOrder = 10;
  sprite.userData.aspect = 256 / 64;
  return sprite;
}
