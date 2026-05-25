import Stats from 'stats.js';
//import GUI from 'lil-gui';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { EffectComposer, EffectPass, RenderPass, BrightnessContrastEffect, BloomEffect, VignetteEffect } from 'postprocessing';
import { SparkRenderer, SplatMesh, dyno } from '@sparkjsdev/spark';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
await RAPIER.init();

function convertVector(v: RAPIER.Vector): THREE.Vector3 {
  const {x, y, z} = v;
  return new THREE.Vector3(x, y, z);
}

/*function convertQuaternion(q: RAPIER.Quaternion): THREE.Quaternion {
  const {w, x, y, z} = q;
  return new THREE.Quaternion(x, y, z, w);
}*/

function computeDroste(point: THREE.Vector3, referencePosition: THREE.Vector3, referenceOrientation: THREE.Quaternion, phase: number, twisting: number, portalAnimation: number): THREE.Vector3 | null {
  // --- Portal animation variables ---
  const portalOpening = THREE.MathUtils.clamp(portalAnimation, 1e-5, 1.0);
  const portalRipple = THREE.MathUtils.clamp(Math.abs(portalAnimation), 0.0, 1.0);
  // --- Local Space ---
  const inverseQuaternion = referenceOrientation.clone().invert();
  const localPoint = point.clone().sub(referencePosition).applyQuaternion(inverseQuaternion);
  const pointDistance = localPoint.length();
  const ray = localPoint.clone().normalize();
  // --- Log-Polar Coordinates in the Riemann Sphere ---
  const theta = Math.atan2(ray.y, ray.x);
  const rho = Math.atanh(ray.z);
  // --- Periodic Annulus ---
  const period = 2.0 * Math.atanh(1.0 - 0.2 * portalOpening);
  // --- Process Annulus Edges ---
  if ((rho < -0.5 * period) || (0.5 * period < rho)) return null;
  // --- Phase Shift ---
  const shiftedRho = rho + period * phase;
  const periodicRho = THREE.MathUtils.euclideanModulo((shiftedRho + 1.5 * period) / period, 3) * period - 1.5 * period;
  // --- Log-Polar Rotation and Scale (Twisting) ---
  const ratio = twisting * period / (2.0 * Math.PI);
  const factor = 1.0 / (1.0 + ratio * ratio);
  const newRho = (periodicRho + theta * ratio) * factor;
  const newTheta = (theta - periodicRho * ratio) * factor;
  // --- Alternate worlds depends on portal opening ---
  //if ((newRho < -0.5 * period) || (0.5 * period < newRho)) return null;
  // --- New Ray ---
  const newZ = Math.tanh(newRho);
  const newPhi = Math.asin(newZ);
  const newRay = new THREE.Vector3(Math.cos(newTheta) * Math.cos(newPhi), Math.sin(newTheta) * Math.cos(newPhi), newZ);
  // --- Radial Effects ---
  const portalPushback = THREE.MathUtils.lerp(1.0, Math.cosh(newRho), portalOpening);
  const waveCoord = Math.abs(newPhi) - Math.asin(portalRipple);
  const waveValue = Math.pow(portalRipple, 3.0) * Math.exp(-1000.0 * waveCoord * waveCoord);
  // -- New Point ---
  return newRay.clone().applyQuaternion(referenceOrientation).multiplyScalar(pointDistance * portalPushback - waveValue).add(referencePosition);
}

// Setup game states
enum GameState {
  LOADING,
  WAITING,
  PLAYING,
  PAUSED,
  FINISHED
};

function physicalGroup(basePhases: number[]) {
  let collisionGroup = 0;
  for (let basePhase of basePhases) {
    collisionGroup += 1 << basePhase;
  }
  return collisionGroup;
}

function handleGroup(basePhases: number[]) {
  return physicalGroup(basePhases) << 3;
}

function triggerGroup(basePhases: number[]) {
  return physicalGroup(basePhases) << 6;
}

// Setup collision groups
enum CollisionGroup {
  PHYSICAL_RED = physicalGroup([0]),
  PHYSICAL_GREEN = physicalGroup([1]),
  PHYSICAL_BLUE = physicalGroup([2]),
  PHYSICAL_WHITE = physicalGroup([0, 1, 2]),
  HANDLE_RED = handleGroup([0]),
  HANDLE_GREEN = handleGroup([1]),
  HANDLE_BLUE = handleGroup([2]),
  HANDLE_WHITE = handleGroup([0, 1, 2]),
  TRIGGER_RED = triggerGroup([0]),
  TRIGGER_GREEN = triggerGroup([1]),
  TRIGGER_BLUE = triggerGroup([2]),
  TRIGGER_WHITE = triggerGroup([0, 1, 2]),
  DETECTOR = 1 << 9,
  WORLD = 1 << 10
};

let gameState: GameState = GameState.LOADING;

const splatPromises: Promise<SplatMesh>[] = [];

const splashContainer = document.getElementById('splash_container')!;
const splashText = document.getElementById('splash_text')!;

// Setup HUD
const hintsEl = document.createElement('div');
hintsEl.style.cssText = [
  'position:fixed', 'bottom:16px', 'left:16px',
  'color:rgba(255,255,255,0.55)', 'font-size:13px',
  'font-family:system-ui,sans-serif', 'line-height:1.7',
  'pointer-events:none', 'user-select:none',
  'text-shadow:0 1px 3px rgba(0,0,0,0.6)',
].join(';');
hintsEl.innerHTML =
  'WASD &mdash; Move &nbsp;&nbsp; Shift &mdash; Sprint &nbsp;&nbsp; Space &mdash; Grab/Drop<br>' +
  'Click + drag &mdash; Orbit camera &nbsp;&nbsp; Scroll &mdash; Zoom<br>' +
  'RF &mdash; Traverse portal &nbsp;&nbsp; (After Power Up 1)<br>' +
  'QE &mdash; Spin portal &nbsp;&nbsp; (After Power Up 2)<br>' +
  'T &mdash; Toggle twist &nbsp;&nbsp; (After Power Up 3)';
document.body.appendChild(hintsEl);

// Setup stats
const stats = new Stats();
//document.body.appendChild(stats.dom);

// Setup renderer
const renderer = new THREE.WebGLRenderer({ powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace
document.body.appendChild(renderer.domElement);

// Setup scene
const scene = new THREE.Scene();
scene.background = new THREE.Color('black');

const ambientLight = new THREE.AmbientLight(0xffffff, 0.38);
scene.add(ambientLight);
const directionalLight = new THREE.DirectionalLight(0xfff5e6, 1.62);
directionalLight.castShadow = true;
scene.add(directionalLight);
scene.add(directionalLight.target);
directionalLight.position.set(0, 1, 0.5);
directionalLight.target.position.set(0, 0, 0);

// Setup player attributes
const playerRadius = 0.1;
const playerSpeed = 1.5;
const sprintSpeed = 3.0;
const rotationSpeed = 7.0;
const spawnPosition = new THREE.Vector3(0, 1, 0);
const playerPivot = new THREE.Group();
scene.add(playerPivot);
playerPivot.position.copy(spawnPosition);

// Setup player model
const playerAsset = './player.glb';
let playerModel: THREE.Object3D | null = null;
let playerMixer: THREE.AnimationMixer | null = null;
new GLTFLoader().load(
  playerAsset,
  (gltf) => {
    playerModel = gltf.scene;
    playerMixer = new THREE.AnimationMixer(playerModel);
    const idleAnimation = playerMixer.clipAction(gltf.animations[0]);
    idleAnimation.setLoop(THREE.LoopRepeat, Infinity);
    idleAnimation.reset().setEffectiveWeight(1).play();
    playerPivot.add(playerModel);
    playerModel.scale.set(0.2, 0.2, 0.2);
    playerModel.position.set(0.0, 0.45, -0.53);
    playerModel.renderOrder = 1;
  },
  undefined,
  (err) => {
    console.warn(`Could not load ${playerAsset}`, err);
  },
);

// Setup camera
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.001, 1000);
camera.position.copy(spawnPosition);
camera.position.z += 1.0;

// Setup post-processing
const brightnessContrastEffect = new BrightnessContrastEffect({ brightness: -0.16, contrast: 0.16 });
const bloomEffect = new BloomEffect({ luminanceThreshold: 0.7, luminanceSmoothing: 0.0, mipmapBlur: true, intensity: 1.5, radius: 0.4 });
const vignetteEffect = new VignetteEffect({ darkness: 0.57, offset: 0.5 });
const composer = new EffectComposer(renderer, { multisampling: 0, frameBufferType: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false });
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new EffectPass(camera, brightnessContrastEffect, bloomEffect, vignetteEffect));
composer.setSize(window.innerWidth, window.innerHeight);

// Handle resize
function handleResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  composer.setSize(width, height);
}

handleResize();
window.addEventListener("resize", handleResize);

// Setup orbit controls
const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;
orbitControls.enablePan = false;
orbitControls.minDistance = 0.03;
orbitControls.maxDistance = 3.0;
orbitControls.minPolarAngle = 0.01
orbitControls.maxPolarAngle = Math.PI - 0.01;
orbitControls.target.copy(spawnPosition);

// Setup Rapier world
const gravity = { x: 0.0, y: -9.81, z: 0.0 };
const rapierWorld = new RAPIER.World(gravity);

// Setup Rapier debug lines
const rapierDebugGeom = new THREE.BufferGeometry();
const rapierDebugPos = new THREE.BufferAttribute(new Float32Array(0), 3);
const rapierDebugCol = new THREE.BufferAttribute(new Float32Array(0), 3);
rapierDebugGeom.setAttribute('position', rapierDebugPos);
rapierDebugGeom.setAttribute('color', rapierDebugCol);
const rapierDebugLines = new THREE.LineSegments(
  rapierDebugGeom,
  new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false }),
);
rapierDebugLines.visible = false;
scene.add(rapierDebugLines);

function updateRapierDebugLines() {
  if (!rapierDebugLines.visible) return;
  const buffers = rapierWorld.debugRender();
  const v = buffers.vertices;
  const c = buffers.colors;
  const nVert = v.length / 3;
  const colors3 = new Float32Array(nVert * 3);
  for (let i = 0; i < nVert; i++) {
    colors3[i * 3 + 0] = c[i * 4 + 0];
    colors3[i * 3 + 1] = c[i * 4 + 1];
    colors3[i * 3 + 2] = c[i * 4 + 2];
  }
  rapierDebugGeom.setAttribute('position', new THREE.BufferAttribute(v.slice(), 3));
  rapierDebugGeom.setAttribute('color', new THREE.BufferAttribute(colors3, 3));
  rapierDebugGeom.getAttribute('position').needsUpdate = true;
  rapierDebugGeom.getAttribute('color').needsUpdate = true;
}

const createGroupMask = (membership: number, filter: number) => {
    return (filter << 16) | membership;
};

// Setup player physical character
const playerBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
playerBodyDesc.setTranslation(spawnPosition.x, spawnPosition.y, spawnPosition.z);
const playerBody = rapierWorld.createRigidBody(playerBodyDesc);

const playerColliderDesc = RAPIER.ColliderDesc.ball(playerRadius);
playerColliderDesc.setCollisionGroups(createGroupMask(CollisionGroup.PHYSICAL_RED, CollisionGroup.PHYSICAL_RED + CollisionGroup.WORLD));
const playerCollider = rapierWorld.createCollider(playerColliderDesc, playerBody);

const playerOffset = 0.01;
const playerController = rapierWorld.createCharacterController(playerOffset);

const playerMass = 1000;
playerController.setCharacterMass(playerMass);
playerController.setApplyImpulsesToDynamicBodies(true);
playerController.disableAutostep();
playerController.disableSnapToGround();
playerController.setUp({ x: 0, y: 1, z: 0 });
playerController.setMaxSlopeClimbAngle(0.0);

function mergeTrimesh(root: THREE.Object3D): { positions: number[]; indices: number[] } {
  const _envTriWorld = new THREE.Vector3();
  const positions: number[] = [];
  const indices: number[] = [];
  let vertexBase = 0;
  const worldMat = new THREE.Matrix4();
  root.updateMatrixWorld(true);
  root.traverse((obj: THREE.Object3D) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geom = mesh.geometry;
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr) return;
    worldMat.copy(mesh.matrixWorld);
    for (let i = 0; i < posAttr.count; i++) {
      _envTriWorld.fromBufferAttribute(posAttr, i).applyMatrix4(worldMat);
      positions.push(_envTriWorld.x, _envTriWorld.y, _envTriWorld.z);
    }
    const indexAttr = geom.getIndex();
    if (indexAttr) {
      for (let i = 0; i < indexAttr.count; i++) {
        indices.push(vertexBase + indexAttr.getX(i));
      }
    } else {
      for (let i = 0; i + 2 < posAttr.count; i += 3) {
        indices.push(vertexBase + i, vertexBase + i + 1, vertexBase + i + 2);
      }
    }
    vertexBase += posAttr.count;
  });
  return { positions, indices };
}

// Setup world collider
const colliderAsset = './world_collider.glb';
let colliderModel: THREE.Object3D | null = null;
let worldBody: RAPIER.RigidBody | null = null;
new GLTFLoader().load(
  colliderAsset,
  (gltf) => {
    colliderModel = gltf.scene;
    const { positions, indices } = mergeTrimesh(colliderModel);
    if (indices.length < 3) {
      console.warn(`${colliderAsset}: no mesh triangles found for static collider`);
      return;
    }
    try {
      const verts = new Float32Array(positions);
      const idx = new Uint32Array(indices);
      worldBody = rapierWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const colliderDesc = RAPIER.ColliderDesc.trimesh(verts, idx);
      colliderDesc.setCollisionGroups(createGroupMask(CollisionGroup.WORLD, CollisionGroup.PHYSICAL_WHITE + CollisionGroup.DETECTOR));
      rapierWorld.createCollider(colliderDesc, worldBody);
      rapierWorld.updateSceneQueries();
    } catch (e) {
      console.error(`${colliderAsset}: failed to build triangle-mesh collider`, e);
    }
  },
  undefined,
  (err) => {
    console.warn(`Could not load ${colliderAsset}`, err);
  },
);

// Setup hand
const handOffset = new THREE.Vector3(0.0, -0.15, 0.0);
const handSpeed = 4.0;
let heldTransmitter: Transmitter | null  = null;
let handJoint: RAPIER.ImpulseJoint | null = null;
const handBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
const handBody = rapierWorld.createRigidBody(handBodyDesc);
const handGeometry = new THREE.SphereGeometry(0.01);
const handMaterial = new THREE.MeshBasicMaterial( { color: 0xffffff } );
const handModel = new THREE.Mesh(handGeometry, handMaterial);
handModel.position.copy(spawnPosition).add(handOffset);
scene.add(handModel);
handModel.visible = false;

// Setup Spark
const sparkRenderer = new SparkRenderer({ renderer, enableLod: false, /*lodRenderScale: 2*/ });
scene.add(sparkRenderer);

//
const portalOrientation = new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3(0, 0, 1), -Math.PI/2);
const referencePos = dyno.dynoVec3(new THREE.Vector3(0, 0, 0));
const referenceQuat = dyno.dynoVec4(new THREE.Vector4(1, 0, 0, 0));
const phase = dyno.dynoFloat(0.0);
const twisting = dyno.dynoFloat(0.0);
const portalAnimation = dyno.dynoFloat(-1.0);
const cameraPos = dyno.dynoVec3(new THREE.Vector3(0, 0, 0));

const initialSpin = new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3(0, 1, 0), 2.0);
referenceQuat.value.copy(portalOrientation.premultiply(initialSpin));

function createSplatEffect(basePhase: number, rgba: THREE.Vector4 = new THREE.Vector4(1, 1, 1, 1), flipColor: number = 0.0) {
  return dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => {
      const d = new dyno.Dyno({
        inTypes: { gsplat: dyno.Gsplat,
          referencePos: "vec3", referenceQuat: "vec4",
          phase: "float", twisting: "float", portalAnimation: "float",
          cameraPos: "vec3", rgba: "vec4", flipColor: "float" },
        outTypes: { gsplat: dyno.Gsplat },
        globals: () => [dyno.unindent(`
          vec3 rotatePos(vec4 rot, vec3 pos) {
            vec3 rotatedPos = pos + cross(2.0 * rot.xyz, cross(rot.xyz, pos) + rot.w * pos);
            return rotatedPos;
          }

          vec4 rotateQuat(vec4 rot, vec4 quat) {
            vec4 rotatedQuat = rot.w * quat;
            rotatedQuat.w = rotatedQuat.w - dot(rot.xyz, quat.xyz);
            rotatedQuat.xyz = rotatedQuat.xyz + quat.w * rot.xyz + cross(rot.xyz, quat.xyz);
            return rotatedQuat;
          }
        `)],
        statements: ({ inputs, outputs }) => dyno.unindentLines(`
          ${outputs.gsplat} = ${inputs.gsplat};
          ${outputs.gsplat}.rgba = mix(${outputs.gsplat}.rgba, ${outputs.gsplat}.rgba.bgra, ${inputs.flipColor});
          ${outputs.gsplat}.rgba *= ${inputs.rgba};
          // --- Portal animation variables ---
          float portalOpening = clamp(${inputs.portalAnimation}, 1e-5, 1.0);
          float portalRipple = clamp(1.0 - abs(${inputs.portalAnimation}), 0.0, 1.0);
          // --- Local Space ---
          vec4 inverseRot = ${inputs.referenceQuat} * vec4(1.0, 1.0, 1.0, -1.0);
          vec3 splatPos = rotatePos(inverseRot, ${inputs.gsplat}.center - ${inputs.referencePos});
          float splatDistance = length(splatPos);
          vec3 splatRay = normalize(splatPos);
          // --- Log-Polar Coordinates in the Riemann Sphere ---
          float theta = atan(splatRay.y, splatRay.x);
          float phi = asin(splatRay.z);
          float rho = atanh(splatRay.z);
          // --- Periodic Annulus ---
          float period = 2.0 * atanh(1.0 - 0.2 * portalOpening);
          // --- Process Annulus Edges ---
          float inside = step(-0.5 * period, rho) * step(rho, 0.5 * period);
          ${outputs.gsplat}.rgba.a *= inside;
          float edgeThickness = 0.05;
          float edge = step(rho, -0.5 * period + edgeThickness * 0.5) + step(0.5 * period - edgeThickness * 0.5, rho);
          vec3 edgeColor = vec3(0.9, 0.7, 0.4);
          ${outputs.gsplat}.rgba.rgb = mix(${outputs.gsplat}.rgba.rgb, edgeColor, edge);
          // --- Phase Shift ---
          rho += period * ${inputs.phase};
          rho = mod((rho + 1.5 * period) / period, 3.0) * period - 1.5 * period;
          // --- Log-Polar Rotation and Scale (Twisting) ---
          float ratio = ${inputs.twisting} * period / (2.0 * PI);
          float factor = 1.0 / (1.0 + ratio * ratio);
          float newRho = (rho + theta * ratio) * factor;
          float newTheta = (theta - rho * ratio) * factor;
          // --- Alternate worlds depends on portal opening ---
          inside = step(-0.5 * period, rho) * step(rho, 0.5 * period);
          ${outputs.gsplat}.rgba.a *= mix(inside, 1.0, portalOpening);
          // --- New Ray ---
          float newZ = tanh(newRho);
          float newPhi = asin(newZ);
          vec3 newRay = vec3(vec2(cos(newTheta), sin(newTheta)) * cos(newPhi), newZ);
          // --- Rotation Quaternion ---
          vec3 crossRays = cross(splatRay, newRay);
          float dotRays = dot(splatRay, newRay);
          vec4 rotationQuat = normalize(vec4(crossRays, 1.0 + dotRays));
          // --- Radial Effects ---
          float portalPushback = mix(1.0, cosh(newRho), portalOpening);
          float waveCoord = abs(newPhi) - asin(portalRipple);
          float waveValue = pow(portalRipple, 3.0) * exp(-1000.0 * waveCoord * waveCoord);
          // --- Rotate Splat Position and Orientation ---
          ${outputs.gsplat}.center = (splatDistance * portalPushback - waveValue) * rotatePos(${inputs.referenceQuat}, newRay) + ${inputs.referencePos};
          ${outputs.gsplat}.quaternion = rotateQuat(${inputs.referenceQuat}, rotateQuat(rotationQuat, rotateQuat(inverseRot, ${inputs.gsplat}.quaternion)));
          // --- Cut a cone of player->camera occlusion ---
          vec3 finalVec = normalize(${outputs.gsplat}.center - ${inputs.referencePos});
          vec3 cameraVec = normalize(${inputs.cameraPos} - ${inputs.referencePos});
          ${outputs.gsplat}.rgba.a *= step(dot(finalVec, cameraVec), 0.9);
        `),
      });

      gsplat = d.apply({
        gsplat,
        referencePos: referencePos,
        referenceQuat: referenceQuat,
        phase: dyno.sub(phase, dyno.dynoConst("float", basePhase)),
        twisting: twisting,
        portalAnimation: portalAnimation,
        cameraPos: cameraPos,
        rgba: dyno.dynoConst("vec4", rgba),
        flipColor: dyno.dynoConst("float", flipColor),
      }).gsplat;

      return { gsplat };
    },
  );
}



//
class Transmitter {
  static instances: Transmitter[] = [];
  index: number;

  pivot: THREE.Group;
  collider: RAPIER.Collider;
  handleCollider: RAPIER.Collider;
  body: RAPIER.RigidBody;
  tipOffset: THREE.Vector3;
  tip: THREE.Group;
  models: SplatMesh[];
  basePhases: number[];

  isActive: boolean;
 
  constructor(basePhases: number[], x:number, y: number, z: number) {
    this.index = Transmitter.instances.length;
    Transmitter.instances.push(this);

    const asset = './transmitter.spz';
    this.basePhases = basePhases;

    const radius = 0.18;
    const height = 0.45;

    this.pivot = new THREE.Group();
    this.pivot.position.set(x, y, z);
    scene.add(this.pivot);

    this.tipOffset = new THREE.Vector3(0.0, height/2, 0.0);
    this.tip = new THREE.Group();
    this.tip.position.copy(this.tipOffset);
    this.pivot.add(this.tip);

    const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z);
    rigidBodyDesc.setLinearDamping(0.8);   // slows swinging back and forth
    rigidBodyDesc.setAngularDamping(1.6);  // slows spinning and rotation
    rigidBodyDesc.setUserData(this);
    this.body = rapierWorld.createRigidBody(rigidBodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cone(height/2, radius);
    colliderDesc.setCollisionGroups(createGroupMask(physicalGroup(this.basePhases), physicalGroup(this.basePhases) + CollisionGroup.WORLD));
    this.collider = rapierWorld.createCollider(colliderDesc, this.body);

    const handleColliderDesc = RAPIER.ColliderDesc.ball(0.5);
    handleColliderDesc.setCollisionGroups(createGroupMask(handleGroup(this.basePhases), CollisionGroup.DETECTOR));
    this.handleCollider = rapierWorld.createCollider(handleColliderDesc, this.body);

    rapierWorld.updateSceneQueries();

    const rgba = new THREE.Vector4(1.0, 1.0, 1.0, 1.0);
    if (basePhases.length > 1) {
      rgba.set(3.0, 3.0, 3.0, 1.0);
    }

    this.models = [];
    for (let basePhase of basePhases) {
      const model = new SplatMesh({ url: asset, lod: false });
      splatPromises.push(model.initialized);

      model.quaternion.identity();
      model.scale.setScalar(0.14);
      model.position.set(0, -0.3, 0);

      model.worldModifier = createSplatEffect(basePhase, rgba);
      model.updateGenerator();

      this.pivot.add(model);
      this.models.push(model);
    }

    this.isActive = false;
  }

  updatePosition(): void {
    const {x, y, z} = this.collider.translation();
    this.pivot.position.set(x, y, z);
  }

  updateOrientation(): void {
    const {w, x, y, z} = this.collider.rotation();
    this.pivot.quaternion.set(x, y, z, w);
  }

  updatePose(): void {
    this.updatePosition();
    this.updateOrientation();
  }

  getTip(): THREE.Vector3 {
    const tipPosition = new THREE.Vector3();
    return this.tip.getWorldPosition(tipPosition);
  }
}



//
class PowerUp {
  static instances: PowerUp[] = [];
  index: number;

  static hasPortal: boolean = false;
  static hasSpin: boolean = false;
  static hasTwist: boolean = false;

  pivot: THREE.Group;
  triggerCollider: RAPIER.Collider;
  body: RAPIER.RigidBody;
  models: SplatMesh[];
  basePhases: number[];

  isActive: boolean;

  constructor(basePhases: number[], radius: number, angle: number, x:number, y: number, z: number) {
    this.index = PowerUp.instances.length;
    PowerUp.instances.push(this);

    const asset = './moebius.spz';
    this.basePhases = basePhases;

    this.pivot = new THREE.Group();
    this.pivot.position.set(x, y, z);
    scene.add(this.pivot);

    const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z);
    rigidBodyDesc.setUserData(this);
    this.body = rapierWorld.createRigidBody(rigidBodyDesc);

    const triggerColliderDesc = RAPIER.ColliderDesc.cylinder(0.1, radius);
    triggerColliderDesc.setCollisionGroups(createGroupMask(triggerGroup(this.basePhases), CollisionGroup.DETECTOR));
    this.triggerCollider = rapierWorld.createCollider(triggerColliderDesc, this.body);

    rapierWorld.updateSceneQueries();

    this.models = [];
    for (let basePhase of basePhases) {
      const model = new SplatMesh({ url: asset, lod: false });
      splatPromises.push(model.initialized);

      model.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
      model.scale.setScalar(0.05);
      model.position.set(0, 0.8, 0);

      model.worldModifier = createSplatEffect(basePhase);
      model.updateGenerator();
      
      this.pivot.add(model);
      this.models.push(model);
    }

    this.isActive = true;
  }

  dispose() {
    if (this.isActive) {
      this.isActive = false;

      for (let model of this.models) {
        model.opacity = 0;
      }
    }
  }
}

// Setup barrier collider desc.
const gltfLoader = new GLTFLoader()
const barrierGLTF = await gltfLoader.loadAsync('./barrier_collider.glb')
const { positions, indices } = mergeTrimesh(barrierGLTF.scene);
const barrierVerts = new Float32Array(positions);
const barrierIdx = new Uint32Array(indices);
const barrierColliderDesc = RAPIER.ColliderDesc.trimesh(barrierVerts, barrierIdx);
barrierColliderDesc.setCollisionGroups(createGroupMask(CollisionGroup.PHYSICAL_WHITE, CollisionGroup.PHYSICAL_WHITE));

class Barrier {
  static instances: Barrier[] = [];
  index: number;

  pivot: THREE.Group;
  collider: RAPIER.Collider;
  body: RAPIER.RigidBody;
  models: SplatMesh[];
  basePhases: number[];

  receivers: Receiver[];
  isActive: boolean;

  constructor(basePhases: number[], receivers: Receiver[], x:number, y: number, z: number) {
    this.index = Barrier.instances.length;
    Barrier.instances.push(this);

    const asset = './barrier.spz';
    this.basePhases = basePhases;

    this.pivot = new THREE.Group();
    this.pivot.position.set(x, y, z);
    scene.add(this.pivot);

    const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z);
    this.body = rapierWorld.createRigidBody(rigidBodyDesc);

    this.collider = rapierWorld.createCollider(barrierColliderDesc, this.body);

    rapierWorld.updateSceneQueries();

    const rgba = new THREE.Vector4(1.0, 1.0, 1.0, 0.1);
    if (basePhases.length > 1) {
      rgba.set(5.0, 5.0, 5.0, 0.1);
    }

    this.models = [];
    for (let basePhase of basePhases) {
      const model = new SplatMesh({ url: asset, lod: false });
      splatPromises.push(model.initialized);

      model.quaternion.identity();
      model.scale.setScalar(1.0);
      model.position.set(0, 0, 0);

      model.worldModifier = createSplatEffect(basePhase, rgba, 1.0);
      model.updateGenerator();

      this.pivot.add(model);
      this.models.push(model);
    }

    this.receivers = receivers;
    this.isActive = true;
  }

  updateState() {
    this.isActive = !this.receivers.every( receiver => receiver.isActive );

    this.body.setEnabled(this.isActive);
    for (let model of this.models) {
      model.opacity = +this.isActive;
    }
  }
}

class Receiver {
  static instances: Receiver[] = [];
  index: number;

  pivot: THREE.Group;
  model: SplatMesh;
  basePhase: number;

  isActive: boolean;

  constructor(basePhase: number, x:number, y: number, z: number) {
    this.index = Receiver.instances.length;
    Receiver.instances.push(this);

    const asset = './receiver.spz';
    this.basePhase = basePhase;

    this.pivot = new THREE.Group();
    this.pivot.position.set(x, y, z);
    scene.add(this.pivot);

    this.model = new SplatMesh({ url: asset, lod: false });
    splatPromises.push(this.model.initialized);

    this.model.quaternion.identity();
    this.model.scale.setScalar(0.14);
    this.model.position.set(0, 0, 0);

    this.model.worldModifier = createSplatEffect(basePhase);
    this.model.updateGenerator();

    this.pivot.add(this.model);

    this.isActive = false;
  }

  getPos(): THREE.Vector3 {
    const position = new THREE.Vector3();
    return this.pivot.getWorldPosition(position);
  }
}

class Beam {
  static instances: Beam[] = [];
  index: number;

  line: Line2;

  static disposeAll() {
    for (let beam of Beam.instances) {
      scene.remove(beam.line);
      beam.line.geometry.dispose();
      beam.line.material.dispose();
    }

    Beam.instances = [];
  }

  constructor(startingPoint: THREE.Vector3, endPoint: THREE.Vector3) {
    this.index = Beam.instances.length;
    Beam.instances.push(this);

    const geometry = new LineGeometry();
    geometry.setPositions([
      startingPoint.x, startingPoint.y, startingPoint.z,
      endPoint.x, endPoint.y, endPoint.z
    ]);

    const beamColor = new THREE.Color(1.0, 0.8, 0.4);
    const material = new LineMaterial({ color: beamColor, linewidth: 20, alphaToCoverage: false} );

    this.line = new Line2( geometry, material );
    scene.add(this.line)
  }
}

class ParallelWorld {
  basePhase: number;
  model: SplatMesh;

  constructor(asset: string, basePhase: number) {
    this.basePhase = basePhase;

    this.model = new SplatMesh({ url: asset, lod: false });
    splatPromises.push(this.model.initialized);
    this.model.quaternion.identity();
    this.model.position.set(0, 0, 0);
    scene.add(this.model);
    this.model.updateGenerator();
    this.model.updateVersion();

    this.model.worldModifier = createSplatEffect(basePhase);
    this.model.updateGenerator();
  }
}

const worldRed = new ParallelWorld('./world_red.spz', 0.0);
const worldGreen = new ParallelWorld('./world_green.spz', 1.0);
const worldBlue = new ParallelWorld('./world_blue.spz', 2.0);

let currentWorld: ParallelWorld = worldRed;

// ############################################################################
// ############################### LEVEL BLOCK ################################
// ############################################################################

// Portal Power
new PowerUp( [0], 0.3, -Math.PI/2,
  4.4, 0.0, 6.4
);

// Spin Power
new PowerUp( [1], 0.3, Math.PI/3,
  8.2, 0.7, -3.9
);

// Twist Power
new PowerUp( [2], 0.3, -Math.PI/4,
  -6.2, 0.0, 4.5
);

// Escape
const escapeTrigger = new PowerUp( [0, 1, 2], 1.0, 0,
  -12.0, 0.0, 6.6
);

// Lab

new Transmitter( [0],
  0.0, 0.5, -2.1
);

new Transmitter( [1],
  0.9, 0.5, -2.4
);

const labReceiver = new Receiver( 0,
  0.7, 2.0, 1.2
);

new Barrier( [0, 1, 2], [labReceiver],
  1.6, 0.8, 1.9
);

// Bedroom

new Transmitter( [2],
  9.4, 1.2, 1.5
);

const bedroomReceiver1 = new Receiver( 0,
  10.4, 2.7, -0.8
);

new Barrier( [0, 1, 2], [bedroomReceiver1],
  11.2, 1.5, -1.0
);

new Transmitter( [0], //[0, 1, 2], <--- This used to be the synchronized transmitter
  11.2, 1.2, -1.0
);

const bedroomReceiver2 = new Receiver( 0,
  10.7, 2.7, -2.8
);

new Barrier( [0, 1, 2], [bedroomReceiver2],
  9.7, 1.5, -3.3
);

const bedroomReceiver3 = new Receiver( 0,
  9.7, 2.7, -3.3
);

new Barrier( [0, 1, 2], [bedroomReceiver3],
  8.2, 1.5, -3.9
);

// Bathroom

new Transmitter( [1],
  10.0, 0.5, 9.5
);

const bathroomReceiver1 = new Receiver( 0,
  8.5, 2.0, 9.0
);

new Barrier( [0, 1, 2], [bathroomReceiver1],
  7.6, 0.8, 8.3
);

new Transmitter( [2],
  7.6, 0.5, 8.3
);

const bathroomReceiver2A = new Receiver( 0,
  8.4, 2.0, 10.5
);

const bathroomReceiver2B = new Receiver( 0,
  6.5, 2.0, 10.0
);

new Barrier( [0, 1, 2], [bathroomReceiver2A, bathroomReceiver2B],
  7.3, 0.8, 10.6
);

new Transmitter( [0],
  7.3, 0.5, 10.6
);

// Hall

const bedroomReceiver = new Receiver(0,
  6.0, 2.0, 4.8
);

new Barrier( [0, 1, 2], [bedroomReceiver],
  5.1, 1.3, 2.6
);

const bathroomReceiverA = new Receiver(0,
  4.6, 2.0, 9.0
);

const bathroomReceiverB = new Receiver(0,
  5.2, 2.0, 8.2
);

const bathroomReceiverC = new Receiver(0,
  5.8, 2.0, 7.4
);

new Barrier( [0, 1, 2], [bathroomReceiverA, bathroomReceiverB, bathroomReceiverC],
  6.1, 0.8, 8.8
);

const hallReceiver1A = new Receiver(0,
  0.8, 2.0, 4.9
);


const hallReceiver1B = new Receiver(0,
  2.4, 2.0, 7.4
);

new Barrier( [0, 1, 2], [hallReceiver1A, hallReceiver1B],
  1.6, 0.8, 6.2
);

const hallReceiver2A = new Receiver(0,
  1.6, 2.0, 6.2
);

const hallReceiver2B = new Receiver(0,
  -0.1, 2.0, 8.9
);

new Barrier( [0, 1, 2], [hallReceiver2A, hallReceiver2B],
  0.6, 0.8, 7.8
);

const hallReceiver3A = new Receiver(0,
  0.6, 2.0, 7.8
);

const hallReceiver3B = new Receiver(0,
  -1.5, 2.0, 5.7
);

new Barrier( [0, 1, 2], [hallReceiver3A, hallReceiver3B],
  -0.6, 0.8, 6.6
);

const kitchenReceiver = new Receiver(0,
  -0.6, 2.0, 6.6
);

new Barrier( [0, 1, 2], [kitchenReceiver],
  -2.3, 0.8, 6.8
);

// ############################################################################
// ############################ END OF LEVEL BLOCK ############################
// ############################################################################

// ############################################################################
// ############################### SOUND BLOCK ################################
// ############################################################################

// Setting up background (non-positional) sounds
function loadingBackgroundSound(
  audioLoader: THREE.AudioLoader, 
  sound: THREE.Audio, 
  filePath: string,
  loop: boolean,
  volume: number,
): void {
  audioLoader.load(filePath, function(buffer: AudioBuffer) {
    sound.setBuffer(buffer);
    sound.setLoop(loop);
    sound.setVolume(volume);
  });
}

// Setting up positional sounds
function loadingPositionalSound(
  audioLoader: THREE.AudioLoader, 
  sound: THREE.PositionalAudio, 
  filePath: string,
  rate: number,
  refDist: number,
  maxDist: number,
  volume: number,
  geometryAttach: THREE.Object3D | THREE.Group
): void {
  audioLoader.load(filePath, function(buffer: AudioBuffer) {
    sound.setBuffer(buffer);
    sound.setLoop(true);  
    sound.setPlaybackRate(rate);
    sound.setRefDistance(refDist);
    sound.setDistanceModel('linear');
    sound.setMaxDistance(maxDist);
    sound.setVolume(volume);
    geometryAttach.add(sound)
  });
}

// Connecting listener to the scene so we can use character position and camera
// orientation
const listener = new THREE.AudioListener();
scene.add(listener);

// Setting up background sound and Cornellius sounds (neither positional)
const audioLoader = new THREE.AudioLoader();
const cornelliusSound = new THREE.Audio(listener);
loadingBackgroundSound(audioLoader, cornelliusSound, './cornellius_intro.mp3', false, 0.4);

const cornelliusPowerUp1Sound = new THREE.Audio(listener);
loadingBackgroundSound(audioLoader, cornelliusPowerUp1Sound, './cornellius_when_we_get_portal.mp3', false, 0.4);

const cornelliusPowerUp2Sound = new THREE.Audio(listener);
loadingBackgroundSound(audioLoader, cornelliusPowerUp2Sound, './cornellius_when_we_get_spin.mp3', false, 0.4);

const cornelliusPowerUp3Sound = new THREE.Audio(listener);
loadingBackgroundSound(audioLoader, cornelliusPowerUp3Sound, './cornellius_when_we_get_twist.mp3', false, 0.4);

const cornelliusEscapedSound = new THREE.Audio(listener);
loadingBackgroundSound(audioLoader, cornelliusEscapedSound, './cornellius_when_we_escape.mp3', false, 0.4);

const bgSound = new THREE.Audio(listener);
loadingBackgroundSound(audioLoader, bgSound, './soundtrack_edited.wav', true, 0.05);

// Setting up positional audios for force fields
const barriersSounds: THREE.PositionalAudio[] = [];
Barrier.instances.forEach((b) => {
  const barrierSound = new THREE.PositionalAudio(listener);
  barriersSounds.push(barrierSound);
  loadingPositionalSound(audioLoader, barrierSound, './force_field.wav', 1, 1, 2, 0.2, b.pivot);
});

// Setting up positional audios for power ups
const powerUpsSounds: THREE.PositionalAudio[] = [];
PowerUp.instances.forEach((p) => {
  const powerUpSound = new THREE.PositionalAudio(listener);
  powerUpsSounds.push(powerUpSound);
  loadingPositionalSound(audioLoader, powerUpSound, './fairy_dust_2.wav', 0.8, 1, 2.5, 0.25, p.pivot);
});

// Setting up positional audios for transmitters
const transmittersSounds: THREE.PositionalAudio[] = [];
Transmitter.instances.forEach((t) => {
  const transmitterSound = new THREE.PositionalAudio(listener);
  transmittersSounds.push(transmitterSound);
  loadingPositionalSound(audioLoader, transmitterSound, './laser_beam.wav', 1, 1, 2, 0.2, t.pivot);
});

// Setting up positional audios for kitchen bubbles
const cauldron = new THREE.Object3D();
cauldron.position.set(-5.41, 1.10, 9.05);
scene.add(cauldron);

const positionalSounds: THREE.PositionalAudio[] = [];
const kitchenSound = new THREE.PositionalAudio(listener);
positionalSounds.push(kitchenSound);
loadingPositionalSound(audioLoader, kitchenSound, './bath_bubbles_edited.wav',  1.0, 1, 5, 0.5, cauldron);

// Setting up positional audios for room fireplace
const fireplace = new THREE.Object3D();
fireplace.position.set(10.62, 1.39, 1.22);
scene.add(fireplace);

const fireplaceSound = new THREE.PositionalAudio(listener);
positionalSounds.push(fireplaceSound);
loadingPositionalSound(audioLoader, fireplaceSound, './fireplace.wav', 1, 1, 5, 0.5, fireplace);

// Setting up positional audios for hall angel choir
const choir = new THREE.Object3D();
choir.position.set(1.89, 3.5, 6.55);
scene.add(choir);

const choirSound = new THREE.PositionalAudio(listener);
positionalSounds.push(choirSound);
loadingPositionalSound(audioLoader, choirSound, './choir_2.wav', 1, 1, 5.5, 0.5, choir);

// Setting up positional audios for bathroom bathtub
const bathtub = new THREE.Object3D();
bathtub.position.set(9.00, 0.80, 9.00);
scene.add(bathtub);

const bathtubSound = new THREE.PositionalAudio(listener);
positionalSounds.push(bathtubSound);
loadingPositionalSound(audioLoader, bathtubSound, './bath_bubbles_edited.wav', 0.4, 1, 3, 0.2, bathtub);

// Setting up positional audios for bathroom pipes
const pipes = new THREE.Object3D();
pipes.position.set(9.16, 1.0, 11.05);
scene.add(pipes);

const pipesSound = new THREE.PositionalAudio(listener);
positionalSounds.push(pipesSound);
loadingPositionalSound(audioLoader, pipesSound, './shower_drain_edited.wav', 0.7, 1, 4, 0.4, pipes);

// ############################################################################
// ############################ END OF SOUND BLOCK ############################
// ############################################################################

// Setup inputs
const input = {
  moveForward: false,
  moveBackward: false,
  moveLeft: false,
  moveRight: false,
  sprint: false,
  spinLeft: false,
  spinRight: false,
  grabDrop: false,
  phaseShift: 0.0,
  toggleTwist: false,
  togglePause: false
};

document.addEventListener('keydown', (event) => {
  switch (event.code) {
    case 'KeyW':
      input.moveForward = true;
      break;
    case 'KeyS':
      input.moveBackward = true;
      break;
    case 'KeyA':
      input.moveLeft = true;
      break;
    case 'KeyD':
      input.moveRight = true;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      input.sprint = true;
      break;
    case 'KeyQ':
      input.spinLeft = true;
      break;
    case 'KeyE':
      input.spinRight = true;
      break;
    case 'KeyR':
      if (input.phaseShift == 0) {
        input.phaseShift = 1;
      }
      break;
    case 'KeyF':
      if (input.phaseShift == 0) {
        input.phaseShift = -1;
      }
      break;
    case 'Space':
      event.preventDefault();
      if (!event.repeat) {
        input.grabDrop = true;
      }
      break;
    case 'KeyT':
      if (!event.repeat) {
        input.toggleTwist = true;
      }
      break;
    case 'Escape':
      event.preventDefault();
      if (!event.repeat) {
        input.togglePause = true;
      }
      break;
  }
});

document.addEventListener('keyup', (event) => {
  switch (event.code) {
    case 'KeyW':
      input.moveForward = false;
      break;
    case 'KeyS':
      input.moveBackward = false;
      break;
    case 'KeyA':
      input.moveLeft = false;
      break;
    case 'KeyD':
      input.moveRight = false;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      input.sprint = false;
      break;
    case 'KeyQ':
      input.spinLeft = false;
      break;
    case 'KeyE':
      input.spinRight = false;
      break;
  }
});



function updateGameMechanics(playerPosition: THREE.Vector3) {
  // Clear all beams
  Beam.disposeAll();

  // Deactivate all transmitters
  for (let transmitter of Transmitter.instances) {
    transmitter.isActive = false;
  }

  // Deactivate all receivers
  for (let receiver of Receiver.instances) {
    receiver.isActive = false;
  }

  // Update beam connections
  for (let receiver of Receiver.instances) {
    const receiverPosition = computeDroste(receiver.getPos(), playerPosition, portalOrientation, phase.value - receiver.basePhase, twisting.value, portalAnimation.value);
    if (receiverPosition != null) {
      const ray = new RAPIER.Ray(receiver.pivot.position, new RAPIER.Vector3(0, -1, 0));
      const hit = rapierWorld.castRay(ray, 10, false, undefined, createGroupMask(CollisionGroup.DETECTOR, CollisionGroup.HANDLE_WHITE));
      if (hit != null) {
        const transmitterBody = hit.collider.parent();
        if (transmitterBody != null) {
          if (transmitterBody.userData != null) {
            const transmitter = transmitterBody.userData as Transmitter;
            for (let basePhase of transmitter.basePhases) {
              const transmitterPosition = computeDroste(transmitter.getTip(), playerPosition, portalOrientation, phase.value - basePhase, twisting.value, portalAnimation.value);
              if (transmitterPosition != null) {
                const beamDirection = receiverPosition.clone().sub(transmitterPosition);
                const beamLength = beamDirection.length();
                beamDirection.divideScalar(beamLength);
                //const beamRay = new RAPIER.Ray(transmitterPosition, beamDirection);
                //const beamHit = rapierWorld.castRay(beamRay, beamLength, false, undefined, createGroupMask(CollisionGroup.DETECTOR, CollisionGroup.WORLD + CollisionGroup.BARRIER));
                const beamHit = null;
                const maxBeamLength = 100.0;
                if ((beamLength < maxBeamLength) && (beamHit == null)) {
                  new Beam(transmitterPosition, receiverPosition);
                  receiver.isActive = true;
                  transmitter.isActive = true;
                }
              }
            }
          }
        }
      }
    }
  }

  // Update barriers
  for (let barrier of Barrier.instances) {
    barrier.updateState();
  }
}



let twistSpeed = 0.0;
let autoSpin = 1.0;

let timeReserve = 0;
rapierWorld.timestep = 0.01;



// Main Loop
let lastTime: DOMHighResTimeStamp | null = null;
const MAX_DELTA_TIME = 0.1; // seconds

function animate( timestamp: DOMHighResTimeStamp ) {
  stats.begin();

  // Frame delta time
  const time = timestamp * 0.001;
  const deltaTime = Math.min(time - (lastTime ?? time), MAX_DELTA_TIME);
  lastTime = time;

  switch (gameState) {
    case GameState.LOADING:
      // Wait for all splats to finish loading
      Promise.all(splatPromises).then(() => {
        // All splats are loaded and ready!
        splashText.textContent = "PRESS SPACE";
        gameState = GameState.WAITING;
        input.grabDrop = false;
      }).catch((error) => {
        console.error("A splat failed to load:", error);
        splashText.textContent = "ERROR";
      });
      break;

    case GameState.WAITING:
      if (input.grabDrop) {
        input.grabDrop = false;
        splashContainer.classList.add('hidden');
        gameState = GameState.PLAYING;
        input.togglePause = false;

        cornelliusSound.onEnded = function() {
          bgSound.play();
        };
        cornelliusSound.play();

          positionalSounds.forEach( sound => sound.play() );
          barriersSounds.forEach( sound => sound.play() );
          powerUpsSounds.forEach( sound => sound.play() );

          powerUpsSounds[escapeTrigger.index].pause();
          escapeTrigger.dispose();
          escapeTrigger.isActive = true;
      }
      break;

    case GameState.PAUSED:
      if (input.togglePause) {
        input.togglePause = false;
        gameState = GameState.PLAYING;
        splashContainer.classList.add('hidden');
      }
      break;

    case GameState.FINISHED:
      break;

    case GameState.PLAYING:
      // Can't traverse portal if holding transmitter or portal is still opening
      if ((heldTransmitter != null) || (portalAnimation.value < 1.0))
      {
        input.phaseShift = 0;
      }

      // Can't grab transmitter if traversing portal
      if (input.phaseShift != 0) {
        handModel.visible = false;
        input.grabDrop = false;
      }



      // --------------
      // --- PORTAL ---
      // ---

      // Update splat effect
      referencePos.value.copy(playerPivot.position);
      cameraPos.value.copy(camera.position);

      // Portal opening progression
      if (PowerUp.hasPortal && (portalAnimation.value < 1.0)) {
        portalAnimation.value += deltaTime;
        if (portalAnimation.value > 1.0) {
          portalAnimation.value = 1.0;
        }
      }

      // Portal spin
      let deltaSpin = 0.0;
      if (PowerUp.hasSpin) {
        if (autoSpin > 0.0) {
          deltaSpin = deltaTime;
          autoSpin -= deltaTime;
          if (autoSpin < 0.0) {
            deltaSpin += autoSpin;
            autoSpin = 0.0;
          }
        }

        const rotationY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deltaTime * (+input.spinLeft - +input.spinRight) + deltaSpin * Math.PI);
        referenceQuat.value.copy(portalOrientation.premultiply(rotationY));
      }

      // Portal twist
      twisting.value += twistSpeed;
      if (twisting.value > 1.0) {
        twisting.value = 1.0;
        twistSpeed = 0.0;
      }
      if (twisting.value < 0.0) {
        twisting.value = 0.0;
        twistSpeed = 0.0;
      }
      if (input.toggleTwist) {
        input.toggleTwist = false;
        if (PowerUp.hasTwist) {
          twistSpeed = (+(twisting.value < 0.5) * 2.0 - 1.0) * 0.02;
        }
      }

      // Portal traversal
      let newPhase = phase.value + deltaTime * input.phaseShift;
      if ((phase.value < -1.0 && -1.0 <= newPhase) || (newPhase <= -1.0 && -1.0 < phase.value)) {
        currentWorld = worldBlue;
        phase.value = 2.0;
        input.phaseShift = 0;
      } else if ((phase.value < 0.0 && 0.0 <= newPhase) || (newPhase <= 0.0 && 0.0 < phase.value)) {
        currentWorld = worldRed;
        phase.value = 0.0;
        input.phaseShift = 0;
      } else if ((phase.value < 1.0 && 1.0 <= newPhase) || (newPhase <= 1.0 && 1.0 < phase.value)) {
        currentWorld = worldGreen;
        phase.value = 1.0;
        input.phaseShift = 0;
      } else if ((phase.value < 2.0 && 2.0 <= newPhase) || (newPhase <= 2.0 && 2.0 < phase.value)) {
        currentWorld = worldBlue;
        phase.value = 2.0;
        input.phaseShift = 0;
      } else if ((phase.value < 3.0 && 3.0 <= newPhase) || (newPhase <= 3.0 && 3.0 < phase.value)) {
        currentWorld = worldRed;
        phase.value = 0.0;
        input.phaseShift = 0;
      } else {
        phase.value = newPhase;
      }
      playerCollider.setCollisionGroups(createGroupMask(physicalGroup([currentWorld.basePhase]), physicalGroup([currentWorld.basePhase]) + CollisionGroup.WORLD));
      rapierWorld.updateSceneQueries();



      // -------------------
      // --- GRAB & DROP ---
      // ---

      if (heldTransmitter == null) {
        const ray = new RAPIER.Ray(playerPivot.position, new RAPIER.Vector3(0, -1, 0));
        const hit = rapierWorld.castRay(ray, 10, false, undefined, createGroupMask(CollisionGroup.DETECTOR, handleGroup([currentWorld.basePhase])));
        if (hit != null) {
          handModel.visible = true;
          const transmitterBody = hit.collider.parent();
          if (transmitterBody != null) {
            const transmitter = transmitterBody.userData as Transmitter;
            handModel.position.copy(transmitter.getTip());
            if (input.grabDrop) {
              heldTransmitter = transmitter;
              heldTransmitter.handleCollider.setCollisionGroups(0);
              rapierWorld.updateSceneQueries();
              handBody.setTranslation(handModel.position, true);
              const jointData = RAPIER.JointData.spherical({ x: 0.0, y: 0.0, z: 0.0 }, transmitter.tipOffset);
              handJoint = rapierWorld.createImpulseJoint(jointData, handBody, transmitterBody, true);
            }
          }
        } else {
          handModel.visible = false;
        }
      } else {
        heldTransmitter.body.wakeUp();
        if (input.grabDrop) {
          heldTransmitter.handleCollider.setCollisionGroups(createGroupMask(handleGroup(heldTransmitter.basePhases), CollisionGroup.DETECTOR));
          rapierWorld.updateSceneQueries();
          heldTransmitter = null;
          handModel.visible = false;
          if (handJoint != null) {
            rapierWorld.removeImpulseJoint(handJoint, true);
            handJoint = null;
          }
        }
      }
      input.grabDrop = false;



      // --------------
      // --- PLAYER ---
      // ---

      // Get current camera orientation
      const cameraOrientation = new THREE.Quaternion();
      camera.getWorldQuaternion(cameraOrientation);

      // Get camera position relative to the player
      const cameraRelativePosition = new THREE.Vector3().subVectors(camera.position, playerPivot.position);
      

      // Local space movement from inputs
      const movementForward = +input.moveForward - +input.moveBackward;
      const movementRight = +input.moveRight - +input.moveLeft;
      const desiredMovement = new THREE.Vector3(movementRight, 0, -movementForward)
      
      // World space movement
      desiredMovement.applyQuaternion(cameraOrientation);
      desiredMovement.y = 0;
      const desiredOrientation = new THREE.Quaternion();
      if (desiredMovement.lengthSq() > 1e-8) {
        desiredMovement.normalize();
        desiredOrientation.setFromUnitVectors(new THREE.Vector3(0, 0, 1), desiredMovement);
      } else {
        desiredOrientation.copy(playerPivot.quaternion);
      }

      // Adjust movement length according to selected speed
      desiredMovement.multiplyScalar(deltaTime * (input.sprint ? sprintSpeed : playerSpeed));

      // Adjust player flight height
      const worldRay = new RAPIER.Ray(playerBody.translation(), new RAPIER.Vector3(0, -1, 0));
      const worldHit = rapierWorld.castRay(worldRay, 10, false, undefined, createGroupMask(CollisionGroup.DETECTOR, CollisionGroup.WORLD));
      if (worldHit != null) {
        desiredMovement.y = 1.0 - worldHit.toi;
      }

      // Current player position
      const playerPosition = convertVector(playerBody.translation());

      // Compute allowed movement based on desired movement (old game state)
      playerController.computeColliderMovement(playerCollider, desiredMovement, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
      const tentativeMovement = convertVector(playerController.computedMovement());
      const tentativePosition = playerPosition.clone().add(tentativeMovement);

      // Update beam connections and barrier states
      updateGameMechanics(tentativePosition);

      // Recompute allowed movement based on tentative movement (new game state)
      playerController.computeColliderMovement(playerCollider, tentativeMovement, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
      const confirmedMovement = convertVector(playerController.computedMovement());
      const confirmedPosition = playerPosition.clone().add(confirmedMovement);

      // Update player movement and position only if confirmed and tentative position are equal
      const playerMovement = new THREE.Vector3(0, 0, 0);
      if (confirmedPosition.distanceTo(tentativePosition) == 0.0) {
        playerMovement.copy(confirmedMovement);
        playerPosition.copy(confirmedPosition);
      }
      else {
        console.log("REWIND APPLIED");
      }

      // Update player rigid body position
      playerBody.setNextKinematicTranslation(playerPosition);

      // Update player pivot pose
      playerPivot.position.copy(playerPosition);
      playerPivot.quaternion.rotateTowards(desiredOrientation, deltaTime * rotationSpeed);

      // Update hand position
      const handMovement = playerPivot.position.clone().add(handOffset).sub(handModel.position);
      const handDistance = handMovement.length();
      if (handDistance > 1e-4) {
        handMovement.multiplyScalar(Math.min(1.0, handSpeed * deltaTime / handDistance));
        handModel.position.add(handMovement);
        handBody.setNextKinematicTranslation(handModel.position);
      }

      // Update player animation mixer
      playerMixer?.update(deltaTime);



      // --------------
      // --- CAMERA ---
      // ---

      // Update camera position
      camera.position.copy(cameraRelativePosition.clone().add(playerPivot.position));

      // Update orbit controls
      orbitControls.target.copy(playerPivot.position);
      orbitControls.update();
      camera.updateMatrixWorld();
      if (playerModel != null) {
        playerModel.visible = orbitControls.getDistance() > 0.1;
      }



      // -------------
      // --- SOUND ---
      // ---

      // Mapping the listener to the player position, but camera orientation so
      // that the 3rd person POV doesn't sound weird
      playerPivot.getWorldPosition(listener.position);
      camera.getWorldQuaternion(listener.quaternion);

      // Play and pause transmitter sounds
      for (let transmitter of Transmitter.instances) {
        const transmitterSound = transmittersSounds[transmitter.index];

        if (transmitter.isActive && !transmitterSound.isPlaying) {
          transmitterSound.play();
        }

        if (!transmitter.isActive && transmitterSound.isPlaying) {
          transmitterSound.pause();
        }
      }

      // Play and pause barrier sounds
      for (let barrier of Barrier.instances) {
        const barrierSound = barriersSounds[barrier.index];

        if (barrier.isActive && !barrierSound.isPlaying) {
          barrierSound.play();
        }

        if (!barrier.isActive && barrierSound.isPlaying) {
          barrierSound.pause();
        }
      }

      // Pause power up sounds
      for (let powerUp of PowerUp.instances) {
        const powerUpSound = powerUpsSounds[powerUp.index];

        if (!powerUp.isActive && powerUpSound.isPlaying) {
          powerUpSound.pause();
        }
      }



      // ---------------
      // --- PHYSICS ---
      // ---

      // Simulate physical effects through multiple smaller steps
      timeReserve += deltaTime;
      while (timeReserve > rapierWorld.timestep) {
        timeReserve -= rapierWorld.timestep;
        rapierWorld.step();
      }

      // Update transmitter poses
      for (let transmitter of Transmitter.instances) {
        transmitter.updatePose();
      }

      // Update colliders debug lines
      if (rapierDebugLines.visible) {
        updateRapierDebugLines();
      }



      // ----------------
      // --- TRIGGERS ---
      // ---

      const ray = new RAPIER.Ray(playerPivot.position, new RAPIER.Vector3(0, -1, 0));
      const hit = rapierWorld.castRay(ray, 10, false, undefined, createGroupMask(CollisionGroup.DETECTOR, triggerGroup([currentWorld.basePhase])));
      if (hit != null) {
        const hitBody = hit.collider.parent();
        if (hitBody != null) {
          const powerUp = hitBody.userData as PowerUp;
          if (powerUp.isActive) {
            powerUp.dispose();

            switch (powerUp.index) {
              case 0:
                PowerUp.hasPortal = true;
                cornelliusPowerUp1Sound.play();
                break;
              case 1:
                PowerUp.hasSpin = true;
                cornelliusPowerUp2Sound.play();
                break;
              case 2:
                input.toggleTwist = true;
                PowerUp.hasTwist = true;
                cornelliusPowerUp3Sound.play();
                break;
              case 3:
                // Escape
                gameState = GameState.FINISHED;
                splashText.textContent = "THE END";
                splashContainer.classList.remove('hidden');

                bgSound.stop();
                cornelliusEscapedSound.play();

                break;
            }
          }
        }
      }



      // -------------
      // --- PAUSE ---
      // ---

      // Pause game
      if (input.togglePause) {
        input.togglePause = false;
        gameState = GameState.PAUSED;
        splashText.textContent = "PAUSED";
        splashContainer.classList.remove('hidden');
      }



      // ---------------------
      // --- UPDATE SPLATS ---
      // ---

      // Receivers
      for (let receiver of Receiver.instances) {
        receiver.model.updateVersion();
      }

      // Transmitters
      for (let transmitter of Transmitter.instances) {
        for (let model of transmitter.models) {
          model.updateVersion();
        }
      }

      // Barriers
      for (let barrier of Barrier.instances) {
        for (let model of barrier.models) {
          model.updateVersion();
        }
      }

      // Power Ups
      for (let powerUp of PowerUp.instances) {
        for (let model of powerUp.models) {
          model.updateVersion();
        }
      }

      // Parallel Worlds
      worldRed.model.updateVersion();
      worldGreen.model.updateVersion();
      worldBlue.model.updateVersion();

      break;
  }

  // Render scene
  composer.render(deltaTime);
  
  stats.end();
}

renderer.setAnimationLoop( animate );



const debugTools = {
  teleport: (room: string) => {
    switch (room) {
      case "lab":
        playerBody.setTranslation({ x : 0.0, y : 1.0, z : 0.0 }, true);
        break;
      case "hall":
        playerBody.setTranslation( { x : 3.5, y : 1.0, z : 5.6 }, true);
        break;
      case "bedroom":
        playerBody.setTranslation( { x : 8.7, y : 1.6, z : -0.8 }, true);
        break;
      case "bathroom":
        playerBody.setTranslation( { x : 8.5, y : 1.0, z : 9.8 }, true);
        break;
      case "kitchen":
        playerBody.setTranslation( { x : -6.6, y : 1.0, z : 7.0 }, true);
        break;
      default:
        console.log("Options: lab, hall, bedroom, bathroom, kitchen.");
    }
  },
  position: () => {
    console.log(playerBody.translation());
  },
  barrier: () => {
    Barrier.instances.forEach( barrier => barrier.receivers = []);
  },
  colliders: () => {
    rapierDebugLines.visible = !rapierDebugLines.visible;
  },
  power: () => {
    PowerUp.hasPortal = true;
    PowerUp.hasSpin = true;
    PowerUp.hasTwist = true;
  },
  reopen: () => {
    portalAnimation.value = -2.0;
  }
};
(window as any).debug = debugTools;