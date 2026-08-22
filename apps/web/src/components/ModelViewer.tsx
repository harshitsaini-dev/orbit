import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { extensionOf } from '@orbit/shared-types';

/**
 * A 3D model, turned around with the mouse.
 *
 * three is already here for the landing hero, so this costs a loader rather
 * than a library. The loaders themselves are imported on demand: a drive full
 * of photographs should not pay for a GLTF parser it never uses.
 *
 * Orbit controls are written out below rather than imported from the examples.
 * What is needed is drag to rotate, wheel to zoom, and nothing else - and the
 * example module brings its own event handling, its own damping loop and an
 * API surface far past that.
 */

interface Props {
  src: string;
  name: string;
  sizeBytes: number;
}

/** Above this a model is offered as a download instead: it is parsed in memory. */
const SIZE_LIMIT = 96 * 1024 * 1024;

type Loaded = { object: THREE.Object3D; triangles: number };

async function parseModel(extension: string, bytes: ArrayBuffer): Promise<Loaded> {
  const decode = (): string => new TextDecoder().decode(bytes);

  if (extension === 'glb' || extension === 'gltf') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();

    const gltf = await loader.parseAsync(
      // A .gltf is JSON and a .glb is binary, and the loader wants each in its
      // own form. Its own sniffing only covers the binary one.
      extension === 'glb' ? bytes : decode(),
      // No base URL: an external texture would be a request to wherever the
      // file says, and this page does not fetch what a file tells it to.
      '',
    );

    return { object: gltf.scene, triangles: countTriangles(gltf.scene) };
  }

  if (extension === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    const object = new OBJLoader().parse(decode());
    return { object, triangles: countTriangles(object) };
  }

  if (extension === 'stl') {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
    const geometry = new STLLoader().parse(bytes);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xb9c2d6, roughness: 0.55, metalness: 0.1 }),
    );
    return { object: mesh, triangles: countTriangles(mesh) };
  }

  if (extension === 'ply') {
    const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
    const geometry = new PLYLoader().parse(bytes);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xb9c2d6, roughness: 0.55, metalness: 0.1 }),
    );
    return { object: mesh, triangles: countTriangles(mesh) };
  }

  throw new Error(`No loader for .${extension}`);
}

function countTriangles(root: THREE.Object3D): number {
  let total = 0;

  root.traverse((node) => {
    const geometry = (node as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!geometry?.attributes?.['position']) return;

    total += geometry.index
      ? geometry.index.count / 3
      : geometry.attributes['position'].count / 3;
  });

  return Math.round(total);
}

/** Frees the GPU memory a model held; a scene dropped without this leaks it. */
function dispose(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    mesh.geometry?.dispose();

    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((one) => one.dispose());
    else material?.dispose();
  });
}

export function ModelViewer({ src, name, sizeBytes }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [triangles, setTriangles] = useState<number | null>(null);

  useEffect(() => {
    if (sizeBytes > SIZE_LIMIT) {
      setError('This model is too large to open in a browser tab.');
      return;
    }

    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let frame = 0;
    const controller = new AbortController();

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';
    host.append(renderer.domElement);

    // Enough light to read a shape by, from two sides so nothing is a
    // silhouette. A model with its own materials still uses them.
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(3, 5, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.7);
    fill.position.set(-4, -2, -3);
    scene.add(fill);

    // Spherical coordinates around the model's centre: the whole of the camera
    // control, and the reason the example module is not imported.
    const target = new THREE.Vector3();
    let radius = 4;
    let theta = 0.7;
    let phi = 1.1;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    function place(): void {
      // Clamped short of the poles, where the camera would flip over.
      phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi));
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.sin(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.cos(theta),
      );
      camera.lookAt(target);
    }

    function resize(): void {
      const { clientWidth, clientHeight } = host!;
      if (!clientWidth || !clientHeight) return;

      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    }

    const observer = new ResizeObserver(resize);
    observer.observe(host);

    function onPointerDown(event: PointerEvent): void {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      renderer.domElement.setPointerCapture(event.pointerId);
    }

    function onPointerMove(event: PointerEvent): void {
      if (!dragging) return;
      theta -= (event.clientX - lastX) * 0.008;
      phi -= (event.clientY - lastY) * 0.008;
      lastX = event.clientX;
      lastY = event.clientY;
      place();
    }

    function onPointerUp(): void {
      dragging = false;
    }

    function onWheel(event: WheelEvent): void {
      event.preventDefault();
      radius = Math.max(0.05, Math.min(2000, radius * (event.deltaY > 0 ? 1.12 : 1 / 1.12)));
      place();
    }

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    let model: THREE.Object3D | null = null;

    void (async () => {
      try {
        const response = await fetch(src, { credentials: 'include', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const loaded = await parseModel(extensionOf(name), await response.arrayBuffer());
        if (cancelled) {
          dispose(loaded.object);
          return;
        }

        model = loaded.object;
        scene.add(model);
        setTriangles(loaded.triangles);

        /*
         * Framed from its own bounding box rather than from a fixed camera
         * position. Models are authored at wildly different scales - one in
         * millimetres, the next in metres - and a fixed camera puts half of
         * them inside the near plane and the rest as a dot.
         */
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const extent = Math.max(size.x, size.y, size.z) || 1;

        box.getCenter(target);
        radius = extent * 2.1;
        camera.near = extent / 500;
        camera.far = extent * 100;
        camera.updateProjectionMatrix();

        resize();
        place();
      } catch (err) {
        if (!cancelled && (err as Error).name !== 'AbortError') {
          setError('Could not read this model.');
        }
      }
    })();

    function tick(): void {
      frame = requestAnimationFrame(tick);
      // Turning slowly on its own until somebody grabs it, which is what makes
      // a still render read as an object rather than a picture.
      if (!dragging && model) {
        theta += 0.0025;
        place();
      }
      renderer.render(scene, camera);
    }

    resize();
    place();
    tick();

    return () => {
      cancelled = true;
      controller.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();

      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);

      if (model) dispose(model);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [src, name, sizeBytes]);

  return (
    <div className="model-view">
      <div className="model-view__stage" ref={hostRef} />

      <div className="model-view__bar">
        <strong style={{ fontSize: 12, letterSpacing: '0.04em' }}>3D</strong>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          {error
            ? error
            : triangles === null
              ? 'Loading…'
              : `${triangles.toLocaleString()} triangles · drag to turn, scroll to zoom`}
        </span>
      </div>
    </div>
  );
}
