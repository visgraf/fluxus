import Stats from 'stats.js';
import GUI from 'lil-gui';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { EffectComposer, EffectPass, RenderPass, BrightnessContrastEffect, BloomEffect, VignetteEffect } from 'postprocessing';
import { SparkRenderer, SplatMesh, SplatEdit, SplatEditSdf, SplatEditSdfType, dyno } from '@sparkjsdev/spark';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
await RAPIER.init();

function convertVector(v: RAPIER.Vector): THREE.Vector3 {
  const {x, y, z} = v;
  return new THREE.Vector3(x, y, z);
}

function convertQuaternion(q: RAPIER.Quaternion): THREE.Quaternion {
  const {w, x, y, z} = q;
  return new THREE.Quaternion(x, y, z, w);
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
  'QE &mdash; Spin portal &nbsp;&nbsp; RF &mdash; Traverse portal';
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
const rotationSpeed = 4.0;
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
  (gltf: GLTFLoader.LoadObject) => {
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
  (err: Error) => {
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
  TRANSMITTER = 1 << 2,
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
const colliderAsset = './collider.glb';
let colliderModel: THREE.Object3D | null = null;
let worldBody: RAPIER.RigidBody | null = null;
new GLTFLoader().load(
  colliderAsset,
  (gltf: GLTFLoader.LoadObject) => {
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
  (err: Error) => {
    console.warn(`Could not load ${colliderAsset}`, err);
  },
);

// Setup hand
const handOffset = new THREE.Vector3(0.0, -0.15, 0.0);
const handSpeed = 4.0;
let emptyHands = true;
let handJoint: RAPIER.ImpulseJoint | null = null;
const handBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
const handBody = rapierWorld.createRigidBody(handBodyDesc);
const handGeometry = new THREE.SphereGeometry(0.01);
const handMaterial = new THREE.MeshBasicMaterial( { color: 0xffffff } );
const handModel = new THREE.Mesh(handGeometry, handMaterial);
handModel.position.set(spawnPosition).add(handOffset);
scene.add(handModel);
handModel.visible = false;

class Transmitter {
  model: THREE.Object3D;
  collider: RAPIER.Collider;
 
  constructor(x:number, y: number, z: number) {
    const radius = 0.2;
    const height = 0.4;

    const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z);
    rigidBodyDesc.setLinearDamping(1.0);   // slows swinging back and forth
    rigidBodyDesc.setAngularDamping(2.0);  // slows spinning / rotation
    const rigidBody = rapierWorld.createRigidBody(rigidBodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cone(height/2, radius);
    colliderDesc.setCollisionGroups(createGroupMask(CollisionGroup.TRANSMITTER, CollisionGroup.ALL));
    this.collider = rapierWorld.createCollider(colliderDesc, rigidBody);

    const geometry = new THREE.ConeGeometry(radius, height);
    const material = new THREE.MeshBasicMaterial( { color: 0xff5500 } );
    this.model = new THREE.Mesh(geometry, material );
    scene.add(this.model);
  }

  updatePosition(): void {
    const {x, y, z} = this.collider.translation();
    this.model.position.set(x, y, z);
  }

  updateOrientation(): void {
    const {w, x, y, z} = this.collider.rotation();
    this.model.quaternion.set(x, y, z, w);
  }

  updatePose(): void {
    this.updatePosition();
    this.updateOrientation();
  }
}

const testTransmitter = new Transmitter(0.5, 0.5, 0.0);

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
rapierDebugLines.visible = true;
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

// Setup Spark
const sparkRenderer = new SparkRenderer({ renderer, enableLod: false, /*lodRenderScale: 2*/ });
scene.add(sparkRenderer);

// Setup player occlusion effect
const occlusionEdit = new SplatEdit();
scene.add(occlusionEdit);
const occlusionShape = new SplatEditSdf({
  type: SplatEditSdfType.INFINITE_CONE,
  opacity: 0,
  radius: 0.5
});
occlusionEdit.add(occlusionShape);
occlusionEdit.position.copy(spawnPosition);

//
const WORLD_ASSETS = {
  original: './original.spz',
  overgrown: './overgrown.spz',
  frozen: './friozen.spz',
  collider: './collider.glb',
} as const;

//
const originalSplat = new SplatMesh({ url: WORLD_ASSETS.original, lod: false });
originalSplat.quaternion.identity();
originalSplat.position.set(0, 0, 0);
scene.add(originalSplat);
originalSplat.updateGenerator();
originalSplat.updateVersion();

// Setup inputs
const input = {
  moveForward: false,
  moveBackward: false,
  moveLeft: false,
  moveRight: false,
  sprint: false,
  spinLeft: false,
  spinRight: false,
  portalForward: false,
  portalBackwards: false,
  grabDrop: false,
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
      input.portalForward = true;
      break;
    case 'KeyF':
      input.portalBackwards = true;
      break;
    case 'Space':
      event.preventDefault();
      if (!event.repeat) {
        input.grabDrop = true;
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
    case 'KeyR':
      input.portalForward = false;
      break;
    case 'KeyF':
      input.portalBackwards = false;
      break;
  }
});



// Main Loop
let lastTime: DOMHighResTimeStamp | null = null;
const MAX_DELTA_TIME = 0.1; // seconds

function animate( timestamp: DOMHighResTimeStamp ) {
  stats.begin();

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

  // Update player occlusion effect
  occlusionEdit.position.copy(playerPosition);
  occlusionEdit.rotation.set(0, Math.PI, 0);
  occlusionEdit.applyQuaternion(cameraOrientation);

  //
  testTransmitter.updatePose();

  // Update grab and drop actions
  if (emptyHands) {
    const ray = new RAPIER.Ray(playerPosition, new RAPIER.Vector3(0, -1, 0));
    const hit = rapierWorld.castRay(ray, 10, false, undefined, createGroupMask(CollisionGroup.ALL, CollisionGroup.TRANSMITTER));
    if (hit != null) {
      handModel.visible = true;
      const transmitterBody = hit.collider.parent();
      const transmitterPosition = convertVector(transmitterBody.translation());
      const transmitterOrientation = convertQuaternion(transmitterBody.rotation());
      const offsetVector = new THREE.Vector3(0.0, 0.2, 0.0);
      handModel.position.copy(transmitterPosition.clone().add(offsetVector.clone().applyQuaternion(transmitterOrientation)));
      if (input.grabDrop) {
        emptyHands = false;
        handBody.setTranslation(handModel.position);
        const jointData = RAPIER.JointData.spherical({ x: 0.0, y: 0.0, z: 0.0 }, offsetVector);
        handJoint = rapierWorld.createImpulseJoint(jointData, handBody, transmitterBody, true);
      }
    } else {
      handModel.visible = false;
    }
  } else {
    if (input.grabDrop) {
      emptyHands = true;
      handModel.visible = false;
      rapierWorld.removeImpulseJoint(handJoint, true);
      handJoint = null;
    }
  }
  input.grabDrop = false;
  
  // Render scene
  composer.render(deltaTime);
  //renderer.render(scene, camera);
  
  stats.end();
}

renderer.setAnimationLoop( animate );