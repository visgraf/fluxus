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

function computeDroste(point: THREE.Vector3, referencePosition: THREE.Vector3, referenceOrientation: THREE.Quaternion, phases: number[], twisting: number): THREE.Vector3[] {
  const inverseQuaternion = referenceOrientation.clone().invert();
  const localPoint = point.clone().sub(referencePosition).applyQuaternion(inverseQuaternion);
  const dist = localPoint.length();
  const ray = localPoint.clone().normalize();
  // --- Log-Polar Coordinates in the Riemann Sphere ---
  const theta = Math.atan2(ray.y, ray.x);
  const rho = Math.atanh(ray.z);
  // --- Periodic Annulus ---
  const lowerZ = -0.8;
  const upperZ = 0.8;
  const lowerRho = Math.atanh(lowerZ);
  const upperRho = Math.atanh(upperZ);
  const period = upperRho - lowerRho;
  // --- Process Annulus Edges ---
  if ((rho < lowerRho) || (upperRho < rho)) {
    return [];
  }
  const newPoints: THREE.Vector3[] = [];
  for (var phase of phases) {
    // --- Phase Shift ---
    const shiftedRho = rho + period * phase;
    const periodicRho = (((shiftedRho - lowerRho + period) / period) % 3) * period + lowerRho - period;
    // --- Log-Polar Rotation and Scale (Twisting) ---
    const ratio = twisting * period / (2.0 * Math.PI);
    const factor = 1.0 / (1.0 + ratio * ratio);
    const newRho = (periodicRho + theta * ratio) * factor;
    const newTheta = (theta - periodicRho * ratio) * factor;
    // --- New Ray ---
    const newZ = Math.tanh(newRho);
    const newPhi = Math.asin(newZ);
    const newRay = new THREE.Vector3(Math.cos(newTheta) * Math.cos(newPhi), Math.sin(newTheta) * Math.cos(newPhi), newZ);
    // -- New Point ---
    const newPoint = newRay.clone().applyQuaternion(referenceOrientation).multiplyScalar(dist * Math.cosh(newRho)).add(referencePosition);
    newPoints.push(newPoint);
  }
  return newPoints;
}

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
  'QE &mdash; Spin portal &nbsp;&nbsp; RF &mdash; Traverse portal &nbsp;&nbsp; T &mdash; Toggle twist';
document.body.appendChild(hintsEl);

// Setup stats
const stats = new Stats();
document.body.appendChild(stats.dom);

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
const rotationSpeed = 6.0;
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
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.copy(spawnPosition);
camera.position.z += playerRadius * 8;

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
orbitControls.minDistance = playerRadius * 2;
orbitControls.maxDistance = playerRadius * 30;
orbitControls.minPolarAngle = 1e-3;
orbitControls.maxPolarAngle = Math.PI - 1e-3;
orbitControls.target.copy(spawnPosition);

// Setup Rapier world
const gravity = { x: 0.0, y: -9.81, z: 0.0 };
const rapierWorld = new RAPIER.World(gravity);

// Setup groups
enum CollisionGroup {
  PLAYER = 1 << 0,
  WORLD = 1 << 1,
  RED = 1 << 2,
  GREEN = 1 << 3,
  BLUE = 1 << 4,
  WHITE = (1 << 2) + (1 << 3) + (1 << 4),
  ALL = 0xFFFF
};

const createGroupMask = (membership: number, filter: number) => {
    return (filter << 16) | membership;
};

// Setup player physical character
const playerBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
playerBodyDesc.setTranslation(spawnPosition.x, spawnPosition.y, spawnPosition.z);
const playerBody = rapierWorld.createRigidBody(playerBodyDesc);

const playerColliderDesc = RAPIER.ColliderDesc.ball(playerRadius);
playerColliderDesc.setCollisionGroups(createGroupMask(CollisionGroup.PLAYER, CollisionGroup.ALL));
const playerCollider = rapierWorld.createCollider(playerColliderDesc, playerBody);

const playerOffset = 0.01;
const playerController = rapierWorld.createCharacterController(playerOffset);

const playerMass = 1000;
playerController.setCharacterMass(playerMass);
playerController.setApplyImpulsesToDynamicBodies(true);
playerController.disableAutostep();
playerController.disableSnapToGround();
playerController.setUp({ x: 0, y: 1, z: 0 });

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
      colliderDesc.setCollisionGroups(createGroupMask(CollisionGroup.WORLD, CollisionGroup.ALL));
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
const cameraPos = dyno.dynoVec3(new THREE.Vector3(0, 0, 0));

function createSplatEffect(basePhase: number, rgba: THREE.Vector4) {
  return dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => {
      const d = new dyno.Dyno({
        inTypes: { gsplat: dyno.Gsplat, referencePos: "vec3", referenceQuat: "vec4", rgba: "vec4", phase: "float", twisting: "float", cameraPos: "vec3" },
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
          ${outputs.gsplat}.rgba *= ${inputs.rgba};
          vec4 inverseRot = ${inputs.referenceQuat} * vec4(1.0, 1.0, 1.0, -1.0);
          vec3 splatPos = rotatePos(inverseRot, ${inputs.gsplat}.center - ${inputs.referencePos});
          vec3 splatRay = normalize(splatPos);
          // --- Log-Polar Coordinates in the Riemann Sphere ---
          float theta = atan(splatRay.y, splatRay.x);
          float phi = asin(splatRay.z);
          float rho = atanh(splatRay.z);
          // --- Periodic Annulus ---
          float lowerZ = -0.8;
          float upperZ = 0.8;
          float lowerRho = atanh(lowerZ);
          float upperRho = atanh(upperZ);
          float period = upperRho - lowerRho;
          // --- Process Annulus Edges ---
          float inside = step(lowerRho, rho) * step(rho, upperRho);
          ${outputs.gsplat}.rgba.a *= inside;
          float edgeThickness = 0.05;
          float edge = step(rho, lowerRho + edgeThickness * 0.5) + step(upperRho - edgeThickness * 0.5, rho);
          vec3 edgeColor = vec3(0.9, 0.7, 0.4);
          ${outputs.gsplat}.rgba.rgb = mix(${outputs.gsplat}.rgba.rgb, edgeColor, edge);
          // --- Phase Shift ---
          rho += period * ${inputs.phase};
          rho = mod((rho - lowerRho + period) / period, 3.0) * period + lowerRho - period;
          // --- Log-Polar Rotation and Scale (Twisting) ---
          float ratio = ${inputs.twisting} * period / (2.0 * PI);
          float factor = 1.0 / (1.0 + ratio * ratio);
          float newRho = (rho + theta * ratio) * factor;
          float newTheta = (theta - rho * ratio) * factor;
          // --- New Ray ---
          float newZ = tanh(newRho);
          float newPhi = asin(newZ);
          vec3 newRay = vec3(vec2(cos(newTheta), sin(newTheta)) * cos(newPhi), newZ);
          // --- Rotation Quaternion ---
          vec3 crossRays = cross(splatRay, newRay);
          float dotRays = dot(splatRay, newRay);
          vec4 rotationQuat = normalize(vec4(crossRays, 1.0 + dotRays));
          // --- Rotate Splat Position and Orientation ---
          ${outputs.gsplat}.center = rotatePos(${inputs.referenceQuat}, rotatePos(rotationQuat, splatPos)) * cosh(newRho) + ${inputs.referencePos};
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
        rgba: dyno.dynoConst("vec4", rgba),
        phase: dyno.sub(phase, dyno.dynoConst("float", basePhase)),
        twisting: twisting,
        cameraPos: cameraPos,
      }).gsplat;

      return { gsplat };
    },
  );
}



//
class Transmitter {
  pivot: THREE.Group;
  collider: RAPIER.Collider;
  body: RAPIER.RigidBody;
  tipOffset: THREE.Vector3;
  tip: THREE.Group;
  models: SplatMesh[];
  basePhases: number[];
  beams: Line2[];
 
  constructor(x:number, y: number, z: number, asset: string, basePhases: number[], collisionGroup: CollisionGroup, rgba: THREE.Vector4) {
    const radius = 0.18;
    const height = 0.45;

    this.basePhases = basePhases;

    const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z);
    rigidBodyDesc.setLinearDamping(1.0);   // slows swinging back and forth
    rigidBodyDesc.setAngularDamping(2.0);  // slows spinning / rotation
    this.body = rapierWorld.createRigidBody(rigidBodyDesc);
    this.body.userData = this;

    const colliderDesc = RAPIER.ColliderDesc.cone(height/2, radius);
    colliderDesc.setCollisionGroups(createGroupMask(collisionGroup, CollisionGroup.ALL - CollisionGroup.WHITE + collisionGroup));
    this.collider = rapierWorld.createCollider(colliderDesc, this.body);

    this.pivot = new THREE.Group();
    scene.add(this.pivot);

    this.tipOffset = new THREE.Vector3(0.0, height/2, 0.0);
    this.tip = new THREE.Group();
    this.tip.position.copy(this.tipOffset);
    this.pivot.add(this.tip);

    this.models = [];
    for (var basePhase of basePhases) {
      const model = new SplatMesh({ url: asset, lod: false });
      model.quaternion.identity();
      model.scale.setScalar(0.14);
      model.position.set(0, -0.3, 0);
      this.pivot.add(model);
      model.worldModifier = createSplatEffect(basePhase, rgba);
      model.updateGenerator();
      this.models.push(model);
    }

    this.beams = [];
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

  addBeam(transmitterPoint: THREE.Vector3, receiverPoint: THREE.Vector3) {
    const geometry = new LineGeometry();
		geometry.setPositions([
      transmitterPoint.x, transmitterPoint.y, transmitterPoint.z,
      receiverPoint.x, receiverPoint.y, receiverPoint.z
    ]);

    const beamColor = new THREE.Color(1.0, 0.8, 0.4);
    const material = new LineMaterial({ color: beamColor, linewidth: 20, alphaToCoverage: false} );

    const beam = new Line2( geometry, material );
    scene.add(beam)

    this.beams.push(beam);
  }

  clearBeams() {
    for (var beam of this.beams) {
      scene.remove(beam);
      beam.geometry.dispose();
      beam.material.dispose();
    }

    this.beams = [];
  }
}

class Receiver {
  pivot: THREE.Group;
  models: SplatMesh[];
  basePhases: number[];

  constructor(x:number, y: number, z: number, angle: number, asset: string, basePhases: number[], rgba: THREE.Vector4) {
    this.basePhases = basePhases;

    this.pivot = new THREE.Group();
    this.pivot.position.set(x, y, z);
    scene.add(this.pivot);

    this.models = [];
    for (var basePhase of basePhases) {
      const model = new SplatMesh({ url: asset, lod: false });
      model.quaternion.setFromAxisAngle( new THREE.Vector3(0, 1, 0), angle);
      model.scale.setScalar(0.14);
      model.position.set(0, 0, 0);
      this.pivot.add(model);
      model.worldModifier = createSplatEffect(basePhase, rgba);
      model.updateGenerator();
      this.models.push(model);
    }
  }

  getPos(): THREE.Vector3 {
    const position = new THREE.Vector3();
    return this.pivot.getWorldPosition(position);
  }

  activate() {
    //
  }

  deactivate() {
    //
  }
}

//
const transmitters: Transmitter[] = [];

transmitters.push(new Transmitter(
  0.5, 0.5, 0.0,
  './transmitter.spz', [0.0, 1.0, 2.0],
  CollisionGroup.WHITE,
  new THREE.Vector4(3.0, 3.0, 3.0, 1.0)
));

transmitters.push(new Transmitter(
  1.0, 0.5, -2.2,
  './transmitter.spz', [1.0],
  CollisionGroup.GREEN,
  new THREE.Vector4(1.0, 1.0, 1.0, 1.0)
));

const receivers: Receiver[] = [];

receivers.push(new Receiver(
  0.75, 1.0, 1.15, Math.PI,
  './receiver.spz', [0.0],
  new THREE.Vector4(1.0, 1.0, 1.0, 1.0)
));

receivers.push(new Receiver(
  -1.35, 1.0, -2.0, Math.PI/2,
  './receiver.spz', [0.0],
  new THREE.Vector4(1.0, 1.0, 1.0, 1.0)
));

//
rapierWorld.updateSceneQueries();

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

class ParallelWorld {
  basePhase: number;
  model: SplatMesh;
  transmitters: Transmitter[];
  receivers: Receiver[];

  collisionGroup: CollisionGroup;

  left: ParallelWorld;
  right: ParallelWorld;

  constructor(asset: string, basePhase: number, collisionGroup: CollisionGroup, rgba: THREE.Vector4) {
    this.basePhase = basePhase;
    this.collisionGroup = collisionGroup

    this.model = new SplatMesh({ url: asset, lod: false });
    this.model.quaternion.identity();
    this.model.position.set(0, 0, 0);
    scene.add(this.model);
    this.model.updateGenerator();
    this.model.updateVersion();

    this.model.worldModifier = createSplatEffect(basePhase, rgba);
    this.model.updateGenerator();

    this.transmitters = [];
    this.receivers = [];

    this.left = this;
    this.right = this;
  }

  setNeighbors(left: ParallelWorld, right: ParallelWorld) {
    this.left = left;
    this.right = right;
  }
}

const worldRed = new ParallelWorld(
  './world_red.spz', 0.0,
  CollisionGroup.RED,
  new THREE.Vector4(1.0, 1.0, 1.0, 1.0)
);

const worldGreen = new ParallelWorld(
  './world_green.spz', 1.0,
  CollisionGroup.GREEN,
  new THREE.Vector4(1.0, 1.0, 1.0, 1.0)
);

const worldBlue = new ParallelWorld(
  './world_blue.spz', 2.0,
  CollisionGroup.BLUE,
  new THREE.Vector4(1.0, 1.0, 1.0, 1.0)
);

worldRed.setNeighbors(worldBlue, worldGreen);
worldGreen.setNeighbors(worldRed, worldBlue);
worldBlue.setNeighbors(worldGreen, worldRed);

let currentWorld: ParallelWorld = worldRed;

// Connecting listener to the scene so we can use character position and camera
// orientation
const listener = new THREE.AudioListener();
scene.add(listener);

// Setting up background sound and Cornellius sound (neither positional)
const cornelliusSound = new THREE.Audio(listener);
const audioLoader = new THREE.AudioLoader();
audioLoader.load('./cornelius_intro.mp3', function(buffer) {
  cornelliusSound.setBuffer(buffer);
  cornelliusSound.setLoop(false);
  cornelliusSound.setVolume(0.7);
});

const bgSound = new THREE.Audio(listener);
audioLoader.load('./soundtrack_edited.wav', function(buffer) {
  bgSound.setBuffer(buffer);
  bgSound.setLoop(true);
  bgSound.setVolume(0.3);
});

// Setting up positional audios for force fields
const positionalSounds: THREE.PositionalAudio[] = [];
const psTrans = new THREE.PositionalAudio(listener);
positionalSounds.push(psTrans);

audioLoader.load('./force_field.wav', function(buffer) {
  psTrans.setBuffer(buffer);
  psTrans.setLoop(true);  
  psTrans.setRefDistance(1);
  psTrans.setDistanceModel('linear');
  psTrans.setMaxDistance(2);
  psTrans.setVolume(0.3);

  testTransmitter.pivot.add(psTrans)
});

// Setting up positional audios for kitchen bubbles
const cauldron = new THREE.Object3D();
cauldron.position.set(-5.26, 0.8, 5.78);
scene.add(cauldron);

const psKitchen = new THREE.PositionalAudio(listener);
positionalSounds.push(psKitchen);

audioLoader.load('./multiple_potions_bubbles.wav', function(buffer) {
  psKitchen.setBuffer(buffer);
  psKitchen.setLoop(true);  
  psKitchen.setRefDistance(1);
  psKitchen.setDistanceModel('linear');
  psKitchen.setMaxDistance(5);
  psKitchen.setVolume(0.4);

  cauldron.add(psKitchen)
});

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
  twist: false,
};

let soundStarted = false;
document.addEventListener('keydown', (event) => {
  // Initializing Cornelius sound when palyer first start playing the game and
  // then initializing the rest
  if (!soundStarted) {
    cornelliusSound.onEnded = function() {
      bgSound.play();
      positionalSounds.forEach((sound) => {
        sound.play();
      });
    };
    cornelliusSound.play();
    soundStarted = true;
  }
  
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
      if ((heldTransmitter == null) && (input.phaseShift == 0)) {
        input.phaseShift = 1;
      }
      break;
    case 'KeyF':
      if ((heldTransmitter == null) && (input.phaseShift == 0)) {
        input.phaseShift = -1;
      }
      break;
    case 'Space':
      event.preventDefault();
      if (!event.repeat && (input.phaseShift == 0)) {
        input.grabDrop = true;
      }
      break;
    case 'KeyT':
      if (!event.repeat) {
        input.twist = !input.twist;
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



// Main Loop
let lastTime: DOMHighResTimeStamp | null = null;
const MAX_DELTA_TIME = 0.1; // seconds

function animate( timestamp: DOMHighResTimeStamp ) {
  stats.begin();

  // Mapping the listener to the player position, but camera orientation so
  // that the 3rd person POV doesn't sound weird
  playerPivot.getWorldPosition(listener.position);
  camera.getWorldQuaternion(listener.quaternion);

  // Frame delta time
  const time = timestamp * 0.001;
  const deltaTime = Math.min(time - (lastTime ?? time), MAX_DELTA_TIME);
  lastTime = time;

  // Get current camera orientation
  const cameraOrientation = new THREE.Quaternion();
  camera.getWorldQuaternion(cameraOrientation);

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

  // Compute allowed movement based on desired movement
  playerController.computeColliderMovement(playerCollider, desiredMovement);
  const playerMovement = convertVector(playerController.computedMovement());

  // Update player rigid body position
  const playerPosition = convertVector(playerBody.translation()).add(playerMovement);
  playerBody.setNextKinematicTranslation(playerPosition);

  // Update hand position
  const handMovement = playerPosition.clone().add(handOffset).sub(handModel.position);
  const handDistance = handMovement.length();
  if (handDistance > 1e-4) {
    handMovement.multiplyScalar(Math.min(1.0, handSpeed * deltaTime / handDistance));
    handModel.position.add(handMovement);
    handBody.setNextKinematicTranslation(handModel.position);
  }

  // Simulate physical effects
  rapierWorld.timestep = deltaTime;
  rapierWorld.step();

  // Update colliders debug lines
  updateRapierDebugLines();

  // Update camera
  camera.position.add(playerMovement);

  // Update orbit controls
  orbitControls.target.copy(playerPosition);
  orbitControls.update();
  camera.updateMatrixWorld();

  // Update player pivot pose
  playerPivot.position.copy(playerPosition);
  playerPivot.quaternion.rotateTowards(desiredOrientation, deltaTime * rotationSpeed);

  // Update animation mixer
  playerMixer?.update(deltaTime);

  // DEBUG
  if (input.grabDrop) {
    console.log(playerPosition);
  }

  // Update grab and drop actions
  if (heldTransmitter == null) {
    const ray = new RAPIER.Ray(playerPosition, new RAPIER.Vector3(0, -1, 0));
    const hit = rapierWorld.castRay(ray, 10, false, undefined, createGroupMask(CollisionGroup.ALL, currentWorld.collisionGroup));
    if (hit != null) {
      handModel.visible = true;
      const transmitterBody = hit.collider.parent();
      if (transmitterBody != null) {
        const transmitter = transmitterBody.userData as Transmitter;
        handModel.position.copy(transmitter.getTip());
        if (input.grabDrop) {
          heldTransmitter = transmitter;
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
      heldTransmitter = null;
      handModel.visible = false;
      if (handJoint != null) {
        rapierWorld.removeImpulseJoint(handJoint, true);
        handJoint = null;
      }
    }
  }
  input.grabDrop = false;

  // Update splat effect
  const rotationY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deltaTime * (+input.spinLeft - +input.spinRight));
  referenceQuat.value.copy(portalOrientation.premultiply(rotationY));
  referencePos.value.copy(playerPosition);
  twisting.value = Number(input.twist);
  cameraPos.value.copy(camera.position);

  //
  if (input.phaseShift != 0) {
    handModel.visible = false;
  }
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

  worldRed.model.updateVersion();
  worldGreen.model.updateVersion();
  worldBlue.model.updateVersion();

  //
  const transmitterPoints: { transmitterPoint: THREE.Vector3, transmitter: Transmitter }[] = [];
  for (var transmitter of transmitters) {
    transmitter.updatePose();
    transmitter.clearBeams();

    const phases = transmitter.basePhases.map( basePhase => phase.value - basePhase );
    const newPositions = computeDroste(transmitter.getTip(), playerPosition, portalOrientation, phases, twisting.value);
    transmitterPoints.push(...newPositions.map( point => ( { transmitterPoint: point, transmitter: transmitter } )));
  }

  //
  const receiverPoints: { receiverPoint: THREE.Vector3, receiver: Receiver }[] = [];
  for (var receiver of receivers) {
    receiver.deactivate();

    const phases = receiver.basePhases.map( basePhase => phase.value - basePhase );
    const newPositions = computeDroste(receiver.getPos(), playerPosition, portalOrientation, phases, twisting.value);
    receiverPoints.push(...newPositions.map( point => ( { receiverPoint: point, receiver: receiver } )));
  }

  //
  const allowedSquaredDistance = 5.0;
  for (const { transmitterPoint, transmitter } of transmitterPoints) {
    let closestReceiver: Receiver | null = null;
    let closestPoint: THREE.Vector3 = new THREE.Vector3();
    let smallestSquaredDistance: number = allowedSquaredDistance;
    for (const { receiverPoint, receiver } of receiverPoints) {
      const squaredDistance = transmitterPoint.distanceToSquared(receiverPoint);
      if (squaredDistance < smallestSquaredDistance) {
        smallestSquaredDistance = squaredDistance;
        closestReceiver = receiver;
        closestPoint.copy(receiverPoint)
      }
    }
    if (closestReceiver != null) {
      closestReceiver.activate();
      transmitter.addBeam(transmitterPoint, closestPoint);
    }
  }
  
  // Render scene
  composer.render(deltaTime);
  
  stats.end();
}

renderer.setAnimationLoop( animate );