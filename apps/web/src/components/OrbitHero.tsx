import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useTheme } from '../lib/theme.js';

interface OrbiterSpec {
  radius: number;
  speed: number;
  size: number;
  /** Radians of tilt applied to the whole ring. */
  tiltX: number;
  tiltZ: number;
  /** How far the accent hue is rotated for this body, in degrees. */
  hueShift: number;
}

const ORBITERS: OrbiterSpec[] = [
  { radius: 2.35, speed: 0.62, size: 0.2, tiltX: 0.18, tiltZ: 0.1, hueShift: -26 },
  { radius: 3.05, speed: 0.44, size: 0.3, tiltX: -0.34, tiltZ: 0.22, hueShift: 14 },
  { radius: 3.8, speed: 0.33, size: 0.22, tiltX: 0.46, tiltZ: -0.16, hueShift: -52 },
  { radius: 4.5, speed: 0.25, size: 0.27, tiltX: -0.22, tiltZ: 0.34, hueShift: 38 },
  { radius: 5.15, speed: 0.19, size: 0.16, tiltX: 0.3, tiltZ: -0.28, hueShift: 68 },
];

/** A soft radial sprite, used for the core's glow. Cheaper than postprocessing bloom. */
function glowTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.28)');
    gradient.addColorStop(0.7, 'rgba(255,255,255,0.06)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function shiftHue(base: THREE.Color, degrees: number, lightness: number): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  return new THREE.Color().setHSL((hsl.h + degrees / 360 + 1) % 1, Math.min(1, hsl.s * 0.95), lightness);
}

/**
 * Connected clouds orbiting one hub, rendered in the same soft-clay language as
 * the rest of the UI: matte materials, generous radii, low contrast, no glass or
 * chrome. Client-side only (zero backend cost), pauses when the tab is hidden,
 * and falls back to a single static frame under prefers-reduced-motion.
 */
export function OrbitHero() {
  const mountRef = useRef<HTMLDivElement>(null);
  const { accent, theme } = useTheme();

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isDark =
      document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);

    const accentColor = new THREE.Color(accent);

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    const cameraHome = new THREE.Vector3(0, 2.1, 9.4);
    camera.position.copy(cameraHome);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Filmic tone mapping keeps the bright core from clipping to flat white.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = isDark ? 1.15 : 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const canvas = renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    mount.appendChild(canvas);

    // --- lighting -------------------------------------------------------
    // Hemisphere fill gives the matte materials their soft, shadowless base;
    // the key light adds just enough form, and a cool rim separates the
    // silhouette from the card behind it.
    scene.add(new THREE.HemisphereLight(isDark ? 0x5a6784 : 0xffffff, isDark ? 0x0d1018 : 0xc7d0e0, isDark ? 1.05 : 1.35));

    const keyLight = new THREE.DirectionalLight(0xffffff, isDark ? 1.5 : 1.9);
    keyLight.position.set(4.5, 7, 5.5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 30;
    keyLight.shadow.radius = 4;
    keyLight.shadow.bias = -0.0015;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(accentColor, isDark ? 1.35 : 0.85);
    rimLight.position.set(-6, -2.5, -4.5);
    scene.add(rimLight);

    const coreLight = new THREE.PointLight(accentColor, isDark ? 9 : 5, 14, 2);
    scene.add(coreLight);

    // --- the hub --------------------------------------------------------
    const coreGroup = new THREE.Group();
    scene.add(coreGroup);

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1.18, 64, 64),
      new THREE.MeshPhysicalMaterial({
        color: accentColor,
        roughness: 0.62,
        metalness: 0,
        clearcoat: 0.35,
        clearcoatRoughness: 0.7,
        emissive: accentColor,
        emissiveIntensity: isDark ? 0.42 : 0.24,
        sheen: 0.6,
        sheenColor: shiftHue(accentColor, 20, 0.85),
      }),
    );
    core.castShadow = true;
    core.receiveShadow = true;
    coreGroup.add(core);

    // A slightly larger back-face shell reads as a soft atmosphere rather than
    // a hard outline.
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.42, 48, 48),
      new THREE.MeshBasicMaterial({
        color: accentColor,
        transparent: true,
        opacity: isDark ? 0.16 : 0.11,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    coreGroup.add(atmosphere);

    const glowSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(),
        color: accentColor,
        transparent: true,
        opacity: isDark ? 0.75 : 0.45,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    glowSprite.scale.setScalar(7.5);
    coreGroup.add(glowSprite);

    // --- orbiters -------------------------------------------------------
    const orbiters = ORBITERS.map((spec, index) => {
      const group = new THREE.Group();
      group.rotation.set(spec.tiltX, 0, spec.tiltZ);
      scene.add(group);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(spec.radius, 0.011, 10, 160),
        new THREE.MeshBasicMaterial({
          color: accentColor,
          transparent: true,
          opacity: isDark ? 0.2 : 0.16,
          depthWrite: false,
        }),
      );
      ring.rotation.x = Math.PI / 2;
      group.add(ring);

      const bodyColor = shiftHue(accentColor, spec.hueShift, isDark ? 0.68 : 0.78);
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(spec.size, 48, 48),
        new THREE.MeshPhysicalMaterial({
          color: bodyColor,
          roughness: 0.78,
          metalness: 0,
          clearcoat: 0.22,
          clearcoatRoughness: 0.85,
          sheen: 0.45,
          sheenColor: bodyColor,
        }),
      );
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);

      // A faint companion just behind each body suggests motion without a
      // full trail system.
      const wake = new THREE.Mesh(
        new THREE.SphereGeometry(spec.size * 0.62, 24, 24),
        new THREE.MeshBasicMaterial({
          color: bodyColor,
          transparent: true,
          opacity: 0.18,
          depthWrite: false,
        }),
      );
      group.add(wake);

      return { group, body, wake, spec, phase: (index / ORBITERS.length) * Math.PI * 2 };
    });

    // --- dust ------------------------------------------------------------
    const dustCount = 220;
    const positions = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i += 1) {
      // Rejection-free spherical shell: keeps the dust off the core.
      const radius = 6 + Math.random() * 5;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi) * 0.55;
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const dust = new THREE.Points(
      dustGeometry,
      new THREE.PointsMaterial({
        color: accentColor,
        size: 0.045,
        transparent: true,
        opacity: isDark ? 0.5 : 0.3,
        sizeAttenuation: true,
        depthWrite: false,
      }),
    );
    scene.add(dust);

    // --- contact shadow ---------------------------------------------------
    const shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.ShadowMaterial({ opacity: isDark ? 0.3 : 0.14 }),
    );
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.position.y = -3.1;
    shadowCatcher.receiveShadow = true;
    scene.add(shadowCatcher);

    // --- interaction ------------------------------------------------------
    const pointer = { x: 0, y: 0 };
    const onPointerMove = (event: PointerEvent) => {
      const rect = mount.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });

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

    // --- loop -------------------------------------------------------------
    const clock = new THREE.Clock();
    let frameId = 0;
    let running = !reducedMotion;

    const render = () => {
      const t = clock.getElapsedTime();

      coreGroup.rotation.y = t * 0.12;
      core.rotation.y = t * 0.2;
      // A slow breath keeps the hub feeling alive without drawing the eye.
      const breath = 1 + Math.sin(t * 0.7) * 0.018;
      core.scale.setScalar(breath);
      atmosphere.scale.setScalar(breath);
      glowSprite.material.opacity = (isDark ? 0.75 : 0.45) * (0.92 + Math.sin(t * 0.9) * 0.08);

      for (const { group, body, wake, spec, phase } of orbiters) {
        const angle = t * spec.speed + phase;
        const x = Math.cos(angle) * spec.radius;
        const z = Math.sin(angle) * spec.radius;
        body.position.set(x, 0, z);
        body.rotation.y = angle * 1.6;

        const trailing = angle - 0.16;
        wake.position.set(Math.cos(trailing) * spec.radius, 0, Math.sin(trailing) * spec.radius);

        group.rotation.y = Math.sin(t * 0.07 + phase) * 0.06;
      }

      dust.rotation.y = t * 0.014;

      // Parallax: the camera leans toward the pointer and eases back on its own.
      camera.position.x += (cameraHome.x + pointer.x * 0.9 - camera.position.x) * 0.035;
      camera.position.y += (cameraHome.y - pointer.y * 0.6 - camera.position.y) * 0.035;
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    };

    const loop = () => {
      if (!running) return;
      render();
      frameId = requestAnimationFrame(loop);
    };

    if (reducedMotion) render();
    else loop();

    // Stop burning CPU and battery while the tab is in the background.
    const onVisibility = () => {
      if (reducedMotion) return;
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(frameId);
      } else if (!running) {
        running = true;
        clock.getDelta();
        loop();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(frameId);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointermove', onPointerMove);
      observer.disconnect();

      glowSprite.material.map?.dispose();
      glowSprite.material.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
          object.geometry.dispose();
          const material = object.material as THREE.Material | THREE.Material[];
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material.dispose();
        }
      });
      renderer.dispose();
      mount.removeChild(canvas);
    };
    // Rebuilt when the accent or theme changes so the whole scene restains.
  }, [accent, theme]);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      style={{ width: '100%', height: '100%', minHeight: 200, pointerEvents: 'none' }}
    />
  );
}
