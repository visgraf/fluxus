import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { SparkRenderer, SplatMesh, dyno } from '@sparkjsdev/spark';

// Scene, renderer and control setups
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 0.5;
camera.position.y = 0.5;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
document.body.style.margin = "0px"

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

// Initializing spark renderer
const spark = new SparkRenderer({ renderer });
scene.add(spark);

// Loading the splats
const apples = new SplatMesh({ url: '/scene.ply' });
apples.quaternion.set(0, 0, 1, 0)
scene.add(apples);

// Playng around with splats
apples.worldModifier = new dyno.Dyno({
  inTypes: { gsplat: dyno.Gsplat },
  outTypes: { gsplat: dyno.Gsplat },
  
  globals: () => [dyno.unindent(`
    vec3 waveRgb(vec3 pos) {
      return vec3(
        0.6 + 0.4 * sin(pos.x * 56.0),
        0.6 + 0.4 * sin(pos.y * 78.0),
        0.6 + 0.4 * cos(pos.z * 90.0)
      );
    }
  `)],

  statements: ({ inputs, outputs }) => dyno.unindentLines(`
    ${outputs.gsplat} = ${inputs.gsplat};
    ${outputs.gsplat}.rgba.rgb *= waveRgb(${inputs.gsplat}.center);
  `),
});

const animateT = dyno.dynoFloat(0);
apples.objectModifier = dyno.dynoBlock(
  { gsplat: dyno.Gsplat },
  { gsplat: dyno.Gsplat },
  ({ gsplat }) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, t: "float" },
      outTypes: { gsplat: dyno.Gsplat },
      
      globals: () => [
        dyno.unindent(`
          float linearWave(float x, float z, float a, float f, float p, float t) {
            float x_offset = a*sin(f*t + x*p);
            float z_offset = a*sin(f*t + z*p*2.0);
            return x_offset + z_offset;
          }
          
          vec3 wave(vec3 pos, float t) {
            float newY = linearWave(pos.x, pos.z, 0.1, 1.0, 15.0, t);
            vec3 offset = vec3(0.0, newY, 0.0);
            return pos + offset;
          }
        `)
      ],
      
      statements: ({ inputs, outputs }) => dyno.unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};
        ${outputs.gsplat}.center = wave(${inputs.gsplat}.center, ${inputs.t});
      `),
    });
    
    gsplat = d.apply({ gsplat, t: animateT }).gsplat;
    return { gsplat };
  },
);
apples.updateGenerator();

// Handle window resizing event
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Animation loop definition and call
function animate(time) {
  animateT.value = time / 1000;
  apples.updateVersion();
  controls.update();
  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);