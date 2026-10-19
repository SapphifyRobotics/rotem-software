import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
export type ViewMode = 'board' | 'plugs' | 'enclosure';
/** Public display geometry only. Sensor coordinates: X right, Y toward USB, Z up. */
export class BoardView {
 private renderer!:THREE.WebGLRenderer;
 private scene=new THREE.Scene();
 private camera=new THREE.PerspectiveCamera(35,1,.01,100);
 private controls?:OrbitControls;
 private holder=new THREE.Group();
 private models=new Map<string,THREE.Object3D>();
 private mode:ViewMode='board';
 private tare=new THREE.Quaternion();
 private current=new THREE.Quaternion();
 loaded:Promise<void>=Promise.resolve();
 constructor(host:HTMLElement){
  try { this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true}); }
  catch { const img=document.createElement('img');img.src='/models/fallback.webp';img.alt='ROTEM enclosure illustration. Interactive orientation requires WebGL; numeric readings remain available.';img.style.cssText='width:100%;height:100%;object-fit:contain';host.append(img);host.dataset.modelError='true';return; }
  this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
  host.appendChild(this.renderer.domElement);
  this.controls=new OrbitControls(this.camera,this.renderer.domElement);
  this.controls.enableDamping=!matchMedia('(prefers-reduced-motion: reduce)').matches;
  this.controls.minDistance=2;this.controls.maxDistance=8;
  this.scene.add(new THREE.HemisphereLight(0xffffff,0x8c7b66,2.4));
  const light=new THREE.DirectionalLight(0xfff3df,3);light.position.set(2,4,3);this.scene.add(light);
  this.scene.add(this.holder);this.holder.add(new THREE.AxesHelper(1.5));
  this.resetCamera();
  this.loaded=Promise.all(['interior','assembled'].map(async name=>{
    const gltf=await new GLTFLoader().loadAsync(`/models/${name}.glb`);
    const object=gltf.scene;const box=new THREE.Box3().setFromObject(object);
    const size=box.getSize(new THREE.Vector3());const center=box.getCenter(new THREE.Vector3());
    const scale=2/Math.max(size.x,size.y,size.z);
    object.position.copy(center).multiplyScalar(-scale);object.scale.setScalar(scale);
    const group=new THREE.Group();group.add(object);group.visible=name==='interior';
    this.holder.add(group);this.models.set(name,group);
  })).then(()=>{this.setMode(this.mode)}).catch(()=>{host.dataset.modelError='true'});
  const resize=()=>{const w=host.clientWidth,h=Math.max(1,host.clientHeight);this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix()};
  new ResizeObserver(resize).observe(host);resize();
  let visible=true;new IntersectionObserver(([e])=>visible=e.isIntersecting).observe(host);
  const loop=()=>{if(visible&&!document.hidden){this.controls?.update();this.renderer.render(this.scene,this.camera)}requestAnimationFrame(loop)};loop();
 }
 setMode(mode:ViewMode){this.mode=mode;for(const [name,model] of this.models)model.visible=name===(mode==='enclosure'?'assembled':'interior')}
 getMode(){return this.mode}
 setOrientation(q:number[]){this.current.set(q[1],q[3],-q[2],q[0]);this.holder.quaternion.copy(this.tare).multiply(this.current)}
 zero(){this.tare.copy(this.current).invert();this.holder.quaternion.identity()}
 unzero(){this.tare.identity()}
 resetCamera(){this.camera.position.set(2.6,2.6,3.3);this.controls?.target.set(0,0,0)}
}
