import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { sensorToDisplayQuaternion, CAD_TO_DISPLAY_X } from "./orientation";
import { FlatBoardView } from "./flatview";
export type ViewMode = "board" | "plugs" | "enclosure";
/** Public display geometry only. Sensor coordinates: X right, Y toward USB, Z up. */
export class BoardView {
  private fallback?: FlatBoardView;
  private sensorQ = [1,0,0,0];
  private referenceQ?: number[];
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  private controls?: OrbitControls;
  private holder = new THREE.Group();
  private models = new Map<string, THREE.Object3D>();
  private mode: ViewMode = "board";
  private tare = new THREE.Quaternion();
  private current = new THREE.Quaternion();
  loaded: Promise<void> = Promise.resolve();
  constructor(host: HTMLElement, onFallback: (reason: string) => void = () => {}) {
    // Let makeView select the live Canvas fallback when WebGL is unavailable.
    // Do not swallow this failure and replace orientation with a static photograph.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    const fallback = (reason: string) => {
      if (this.fallback) return;
      this.controls?.dispose();
      host.replaceChildren();
      this.fallback = new FlatBoardView(host);
      this.fallback.setMode(this.mode);
      if (this.referenceQ) { this.fallback.setOrientation(this.referenceQ); this.fallback.zero(); }
      this.fallback.setOrientation(this.sensorQ);
      onFallback(reason);
    };
    this.renderer.domElement.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      fallback("Graphics connection lost. Live compatibility view is active.");
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 8;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x667b96, 2.4));
    const light = new THREE.DirectionalLight(0xf5f8ff, 3);
    light.position.set(2, 4, 3);
    this.scene.add(light);
    this.scene.add(this.holder);
    const axes = new THREE.AxesHelper(1.5);
    axes.rotation.x = CAD_TO_DISPLAY_X;
    this.holder.add(axes);
    this.resetCamera();
    this.loaded = Promise.all(
      ["interior", "assembled"].map(async (name) => {
        const gltf = await new GLTFLoader().loadAsync(`/models/${name}.glb`);
        const object = gltf.scene;
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const scale = 2 / Math.max(size.x, size.y, size.z);
        object.position.copy(center).multiplyScalar(-scale);
        object.scale.setScalar(scale);
        const group = new THREE.Group();
        group.add(object);
        // The public meshes are authored in CAD Z-up, not glTF Y-up.
        group.rotation.x = CAD_TO_DISPLAY_X;
        group.visible = name === "interior";
        this.holder.add(group);
        this.models.set(name, group);
      }),
    )
      .then(() => {
        this.setMode(this.mode);
      })
      .catch(() => {
        fallback("The detailed model could not load. Live compatibility view is active.");
      });
    const resize = () => {
      const w = host.clientWidth,
        h = Math.max(1, host.clientHeight);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(host);
    resize();
    let visible = true;
    new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(
      host,
    );
    const loop = () => {
      if (this.fallback) return;
      if (visible && !document.hidden) {
        this.controls?.update();
        this.renderer.render(this.scene, this.camera);
      }
      requestAnimationFrame(loop);
    };
    loop();
  }
  setMode(mode: ViewMode) {
    this.mode = mode;
    this.fallback?.setMode(mode);
    for (const [name, model] of this.models)
      model.visible =
        name === (mode === "enclosure" ? "assembled" : "interior");
  }
  getMode() {
    return this.mode;
  }
  setOrientation(q: number[]) {
    const display = sensorToDisplayQuaternion(q);
    if (!display) return;
    this.sensorQ = [...q];
    this.fallback?.setOrientation(q);
    this.current.set(...display);
    this.holder.quaternion.copy(this.tare).multiply(this.current);
  }
  zero() {
    this.referenceQ = [...this.sensorQ];
    this.fallback?.zero();
    this.tare.copy(this.current).invert();
    this.holder.quaternion.identity();
  }
  unzero() {
    this.referenceQ = undefined;
    this.fallback?.unzero();
    this.tare.identity();
    this.holder.quaternion.copy(this.current);
  }
  resetCamera() {
    this.camera.position.set(2.6, 2.6, 3.3);
    this.controls?.target.set(0, 0, 0);
  }
}
