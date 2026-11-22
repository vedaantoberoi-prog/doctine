import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { world } from '@/lib/world';
import { createDocumentTexture, type DocumentKind } from './documentTextures';

type Vec3 = [number, number, number];

type DocumentSpec = {
  kind: DocumentKind;
  home: Vec3;
  homeRotation: Vec3;
  target: Vec3;
  homeScale: number;
};

// Before you scroll, the papers float in a loose ring around the archive: close enough to stay in frame on a
// phone (no sideways shift) and beside the text on a wide screen (picture shifted right), then they file in.
const DOCUMENT_SPECS: DocumentSpec[] = [
  { kind: 'report', home: [1.7, 1.45, 1.1], homeRotation: [0.2, -0.5, 0.08], target: [-0.65, 0.35, 0.1], homeScale: 1 },
  { kind: 'prescription', home: [1.75, -0.85, 0.8], homeRotation: [-0.1, 0.4, -0.12], target: [0.65, 0.35, 0.1], homeScale: 1 },
  { kind: 'schedule', home: [-1.75, -1.5, 1.2], homeRotation: [0.3, 0.2, 0.1], target: [-0.65, -1.25, 0.1], homeScale: 0.95 },
  { kind: 'profile', home: [-1.7, 1.5, 0.6], homeRotation: [-0.2, -0.3, -0.05], target: [0.65, -1.25, 0.1], homeScale: 0.9 },
  { kind: 'dates', home: [1.55, 0.35, -1.3], homeRotation: [0, -0.6, 0.2], target: [0, 0.35, 0.25], homeScale: 0.9 },
  { kind: 'report', home: [-2.3, 2.45, -2.4], homeRotation: [0.1, 0.3, 0], target: [0, -0.55, -0.35], homeScale: 0.7 },
  { kind: 'prescription', home: [1.35, 2.5, -2.2], homeRotation: [0, -0.2, 0.15], target: [0, -2.05, -0.35], homeScale: 0.65 },
  { kind: 'schedule', home: [-2.45, 0.15, -1.8], homeRotation: [0.2, 0.5, -0.1], target: [0, 0.9, -0.35], homeScale: 0.6 },
];

const TARGET_SCALE = 0.55;

function smootherStep(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function DocumentSheet({
  spec,
  index,
  reduced,
}: {
  spec: DocumentSpec;
  index: number;
  reduced: boolean;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const texture = useMemo(() => createDocumentTexture(spec.kind), [spec.kind]);
  useEffect(() => () => texture.dispose(), [texture]);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // each paper leaves a little after the one before it, so they file in one by one, not as a block
    const raw = THREE.MathUtils.clamp(world.gather * 1.35 - index * 0.05, 0, 1);
    const p = smootherStep(raw);
    const arrive = smootherStep(THREE.MathUtils.clamp(world.intro * 1.6 - index * 0.08, 0, 1));
    const t = state.clock.elapsedTime;
    const phase = index * 1.7;
    const bob = reduced ? 0 : Math.sin(t * 0.6 + phase) * 0.08 * (1 - p);
    const sway = reduced ? 0 : Math.sin(t * 0.35 + phase) * 0.35 * (1 - p);

    mesh.position.set(
      THREE.MathUtils.lerp(spec.home[0], spec.target[0], p),
      THREE.MathUtils.lerp(spec.home[1], spec.target[1], p) + bob - (1 - arrive) * 0.9,
      THREE.MathUtils.lerp(spec.home[2], spec.target[2], p),
    );
    mesh.rotation.set(
      THREE.MathUtils.lerp(spec.homeRotation[0], 0, p),
      THREE.MathUtils.lerp(spec.homeRotation[1] + sway, 0, p),
      THREE.MathUtils.lerp(spec.homeRotation[2], 0, p),
    );
    mesh.scale.setScalar(THREE.MathUtils.lerp(spec.homeScale, TARGET_SCALE, p) * (0.6 + 0.4 * arrive));
    (mesh.material as THREE.MeshStandardMaterial).opacity = arrive;
  });

  return (
    <mesh ref={meshRef} castShadow>
      <planeGeometry args={[1.1, 1.5]} />
      <meshStandardMaterial map={texture} roughness={0.85} metalness={0} side={THREE.DoubleSide} transparent />
    </mesh>
  );
}

export function FloatingDocuments({ reduced, count }: { reduced: boolean; count: number }) {
  return (
    <group>
      {DOCUMENT_SPECS.slice(0, count).map((spec, i) => (
        <DocumentSheet key={i} spec={spec} index={i} reduced={reduced} />
      ))}
    </group>
  );
}
