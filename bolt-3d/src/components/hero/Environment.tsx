import { useMemo } from 'react';
import { Cloud, Clouds } from '@react-three/drei';
import * as THREE from 'three';

export const SKY_TOP = new THREE.Color('#1B56C2');
export const SKY_MID = new THREE.Color('#246BDB');
export const SKY_HORIZON = new THREE.Color('#B9D3F2');

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const skyFragment = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uMid;
  uniform vec3 uHorizon;
  varying vec3 vDir;
  void main() {
    float h = vDir.y;
    vec3 color = mix(uHorizon, uMid, smoothstep(0.0, 0.3, h));
    color = mix(color, uTop, smoothstep(0.3, 0.9, h));
    gl_FragColor = vec4(color, 1.0);
  }
`;

export function SkyDome() {
  const uniforms = useMemo(
    () => ({ uTop: { value: SKY_TOP }, uMid: { value: SKY_MID }, uHorizon: { value: SKY_HORIZON } }),
    [],
  );
  return (
    <mesh scale={80}>
      <sphereGeometry args={[1, 32, 16]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={skyVertex}
        fragmentShader={skyFragment}
        side={THREE.BackSide}
        depthWrite={false}
        fog={false}
      />
    </mesh>
  );
}

const CLOUD_FIELDS: Array<{ position: [number, number, number]; bounds: [number, number, number]; opacity: number }> = [
  { position: [-7, -5.2, -10], bounds: [9, 2, 2], opacity: 0.55 },
  { position: [8, -6, -13], bounds: [11, 2.4, 2], opacity: 0.5 },
  { position: [-1, -7.2, -18], bounds: [14, 2.6, 3], opacity: 0.45 },
  { position: [-15, 2.5, -24], bounds: [10, 2, 2], opacity: 0.4 },
  { position: [15, 3.4, -26], bounds: [12, 2.2, 2], opacity: 0.38 },
  { position: [-3, 7, -30], bounds: [16, 2.5, 3], opacity: 0.3 },
];

// A soft round puff drawn in the page, so the clouds never fetch an image from another site
// (drei's default cloud texture is downloaded from a public CDN).
function cloudTexture(): string {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.65)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas.toDataURL('image/png');
}

export function CloudField({ reduced }: { reduced: boolean }) {
  const texture = useMemo(cloudTexture, []);
  return (
    <Clouds material={THREE.MeshLambertMaterial} limit={200} range={120} texture={texture}>
      {CLOUD_FIELDS.map((cloud, i) => (
        <Cloud
          key={i}
          position={cloud.position}
          bounds={cloud.bounds}
          volume={6}
          segments={28}
          seed={i + 3}
          color="#FFFFFF"
          opacity={cloud.opacity}
          fade={60}
          speed={reduced ? 0 : 0.08}
        />
      ))}
    </Clouds>
  );
}

export function StonePlatform() {
  return (
    <group>
      <mesh position={[0, -2.6, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[4.2, 4.5, 0.5, 96]} />
        <meshPhysicalMaterial color="#E4E0D6" roughness={0.36} clearcoat={0.45} clearcoatRoughness={0.3} />
      </mesh>
      <mesh position={[0, -2.9, 0]} receiveShadow>
        <cylinderGeometry args={[4.6, 4.6, 0.12, 96]} />
        <meshStandardMaterial color="#C9CFD8" roughness={0.5} metalness={0.4} />
      </mesh>
    </group>
  );
}

export function Pillars() {
  return (
    <group>
      {[
        [-6.2, -0.4, -6],
        [6.6, -0.4, -8],
      ].map(([x, y, z]) => (
        <mesh key={`${x}-${z}`} position={[x, y, z]} castShadow receiveShadow>
          <cylinderGeometry args={[0.28, 0.32, 6.4, 32]} />
          <meshStandardMaterial color="#E9E5DC" roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}
