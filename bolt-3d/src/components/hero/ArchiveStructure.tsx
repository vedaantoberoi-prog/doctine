import { useMemo } from 'react';
import * as THREE from 'three';

const ARCHIVE_CENTER: [number, number, number] = [0, -0.55, 0];

const WIDTH = 2.8;
const HEIGHT = 3.6;
const DEPTH = 1.2;
const FRAME = 0.07;

type Vec3 = [number, number, number];

const FRAME_POSTS = [-1, 1].flatMap((x) =>
  [-1, 1].map((z) => ({
    position: [x * (WIDTH / 2 - FRAME / 2), 0, z * (DEPTH / 2 - FRAME / 2)] as Vec3,
    scale: [FRAME, HEIGHT, FRAME] as Vec3,
  })),
);

const FRAME_RAILS = [-1, 1].flatMap((y) => [
  ...[-1, 1].map((z) => ({
    position: [0, y * (HEIGHT / 2 - FRAME / 2), z * (DEPTH / 2 - FRAME / 2)] as Vec3,
    scale: [WIDTH, FRAME, FRAME] as Vec3,
  })),
  ...[-1, 1].map((x) => ({
    position: [x * (WIDTH / 2 - FRAME / 2), y * (HEIGHT / 2 - FRAME / 2), 0] as Vec3,
    scale: [FRAME, FRAME, DEPTH] as Vec3,
  })),
]);

const frameEdges = [...FRAME_POSTS, ...FRAME_RAILS];

const shelfHeights = [1.5, 0, -1.5];

const ribbonCurves: THREE.Vector3[][] = [
  [
    new THREE.Vector3(-2.5, -1.7, 0.9),
    new THREE.Vector3(-2.0, -0.4, 0.6),
    new THREE.Vector3(-1.7, 0.7, 0.5),
    new THREE.Vector3(-1.9, 1.9, 0.8),
  ],
  [
    new THREE.Vector3(2.5, -1.2, 0.9),
    new THREE.Vector3(2.0, 0.1, 0.6),
    new THREE.Vector3(1.7, 1.0, 0.5),
    new THREE.Vector3(1.9, 2.0, 0.8),
  ],
];

export function ArchiveStructure() {
  const frameMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#DCE3EC', metalness: 0.9, roughness: 0.22 }),
    [],
  );
  const glassMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: '#E4EFFC',
        roughness: 0.04,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
        transmission: 0.94,
        thickness: 0.3,
        ior: 1.45,
        attenuationColor: '#BFD9F5',
        attenuationDistance: 2,
      }),
    [],
  );
  const ribbonMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#C89A57', metalness: 0.85, roughness: 0.25 }),
    [],
  );
  const ribbonGeometries = useMemo(
    () => ribbonCurves.map((points) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 64, 0.012, 8)),
    [],
  );

  return (
    <group position={ARCHIVE_CENTER}>
      {frameEdges.map((edge, i) => (
        <mesh key={i} position={edge.position} scale={edge.scale} material={frameMaterial} castShadow>
          <boxGeometry args={[1, 1, 1]} />
        </mesh>
      ))}

      <mesh position={[0, 0, -DEPTH / 2 + 0.05]} material={glassMaterial}>
        <boxGeometry args={[WIDTH - FRAME * 2, HEIGHT - FRAME * 2, 0.03]} />
      </mesh>

      {shelfHeights.map((y) => (
        <mesh key={y} position={[0, y, 0]} material={glassMaterial}>
          <boxGeometry args={[WIDTH - FRAME * 2, 0.03, DEPTH - FRAME * 2]} />
        </mesh>
      ))}

      {ribbonGeometries.map((geometry, i) => (
        <mesh key={i} geometry={geometry} material={ribbonMaterial} />
      ))}
    </group>
  );
}
