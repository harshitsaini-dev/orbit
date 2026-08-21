import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const ORBITERS = [
  { radius: 2.2, speed: 0.55, size: 0.2, tilt: 0.0 },
  { radius: 3.0, speed: 0.38, size: 0.26, tilt: 0.35 },
  { radius: 3.8, speed: 0.27, size: 0.17, tilt: -0.28 },
  { radius: 4.6, speed: 0.19, size: 0.22, tilt: 0.55 },
];

/**
 * Connected clouds orbiting one hub. Renders client-side only (zero backend
 * cost), pauses when the tab is hidden, and degrades to a static frame when the
 * user prefers reduced motion.
 */
export function OrbitHero() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6c8cff';
    const accentColor = new THREE.Color(accent);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 2.4, 8);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const keyLight = new THREE.DirectionalLight(accentColor, 1.6);
    keyLight.position.set(4, 6, 6);
    scene.add(keyLight);

    // Central hub.
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.15, 3),
      new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.35, metalness: 0.1 }),
    );
    scene.add(core);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 32, 32),
      new THREE.MeshBasicMaterial({ color: accentColor, transparent: true, opacity: 0.09 }),
    );
    scene.add(halo);

    const orbiters = ORBITERS.map((config, i) => {
      const group = new THREE.Group();
      group.rotation.x = config.tilt;

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(config.radius, 0.006, 8, 96),
        new THREE.MeshBasicMaterial({ color: accentColor, transparent: true, opacity: 0.22 }),
      );
      ring.rotation.x = Math.PI / 2;
      group.add(ring);

      const sphere = new THREE.Mesh(
        new THREE.IcosahedronGeometry(config.size, 2),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.05 }),
      );
      group.add(sphere);
      scene.add(group);

      return { group, sphere, config, phase: (i / ORBITERS.length) * Math.PI * 2 };
    });

    const resize = () => {
      const { clientWidth, clientHeight } = mount;
      if (clientWidth === 0 || clientHeight === 0) return;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    const clock = new THREE.Clock();
    let frameId = 0;
    let running = !reducedMotion;

    const render = () => {
      const t = clock.getElapsedTime();
      core.rotation.y = t * 0.15;
      for (const { group, sphere, config, phase } of orbiters) {
        const angle = t * config.speed + phase;
        sphere.position.set(Math.cos(angle) * config.radius, 0, Math.sin(angle) * config.radius);
        group.rotation.z = Math.sin(t * 0.08) * 0.05;
      }
      renderer.render(scene, camera);
    };

    const loop = () => {
      if (!running) return;
      render();
      frameId = requestAnimationFrame(loop);
    };

    if (reducedMotion) render();
    else loop();

    // Stop burning CPU/battery while the tab is in the background.
    const onVisibility = () => {
      if (reducedMotion) return;
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(frameId);
      } else if (!running) {
        running = true;
        loop();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(frameId);
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const material = object.material as THREE.Material | THREE.Material[];
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material.dispose();
        }
      });
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      style={{ width: '100%', height: 'clamp(200px, 32vw, 320px)', pointerEvents: 'none' }}
    />
  );
}
