import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { world } from '@/lib/world';

// Fine detail around the archive: two slim champagne rings, like the rings of a measuring instrument, turning very
// slowly, and three frosted-glass record cards that come to rest beside the shelves as the papers are filed.
const CARDS: { home: [number, number, number]; target: [number, number, number]; tilt: number }[] = [
  { home: [-3.1, 0.9, 1.4], target: [-1.75, 0.6, 0.35], tilt: 0.5 },
  { home: [2.9, 2.3, 0.4], target: [1.75, 0.6, 0.35], tilt: -0.45 },
  { home: [-2.2, -1.6, 2.1], target: [-1.75, -1.1, 0.35], tilt: 0.3 },
];

export function Instruments({ reduced, light }: { reduced: boolean; light: boolean }) {
  const rings = useRef<THREE.Group>(null);
  const cards = useRef<(THREE.Mesh | null)[]>([]);
  const gold = useMemo(() => new THREE.MeshStandardMaterial({ color: '#BFD3E6', metalness: 0.8, roughness: 0.22, emissive: '#4FB6DA', emissiveIntensity: 0.25 }), []);
  // Frosted, not see-through glass: transmission would cost a second pass over the whole scene for three small cards.
  const frosted = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#EAF2FB', roughness: 0.35, metalness: 0.1, transparent: true, opacity: light ? 0.6 : 0.72 }),
    [light],
  );

  useFrame((state) => {
    const t = reduced ? 0 : state.clock.elapsedTime;
    if (rings.current) {
      rings.current.rotation.z = t * 0.03;
      rings.current.rotation.y = Math.sin(t * 0.11) * 0.08;
      rings.current.scale.setScalar(0.85 + 0.15 * world.intro);
    }
    const g = THREE.MathUtils.smootherstep(world.gather, 0.1, 0.95);
    cards.current.forEach((mesh, i) => {
      if (!mesh) return;
      const c = CARDS[i];
      const bob = reduced ? 0 : Math.sin(t * 0.5 + i * 2.1) * 0.07 * (1 - g);
      mesh.position.set(
        THREE.MathUtils.lerp(c.home[0], c.target[0], g),
        THREE.MathUtils.lerp(c.home[1], c.target[1], g) + bob,
        THREE.MathUtils.lerp(c.home[2], c.target[2], g),
      );
      mesh.rotation.set(0, THREE.MathUtils.lerp(c.tilt, 0, g), THREE.MathUtils.lerp(c.tilt * 0.3, 0, g));
      mesh.scale.setScalar(world.intro);
    });
  });

  return (
    <group>
      {/* The rings stand behind the archive, facing the viewer, so they frame it and never cross the papers */}
      <group ref={rings} position={[0, -0.3, -1.9]}>
        <mesh material={gold}>
          <torusGeometry args={[2.75, 0.012, 8, 160]} />
        </mesh>
        <mesh material={gold} rotation={[0.5, 0.2, 0]}>
          <torusGeometry args={[2.35, 0.008, 8, 160]} />
        </mesh>
      </group>
      {CARDS.map((_, i) => (
        <mesh
          key={i}
          ref={(m) => {
            cards.current[i] = m;
          }}
          material={frosted}
        >
          <boxGeometry args={[0.62, 0.86, 0.03]} />
        </mesh>
      ))}
    </group>
  );
}
