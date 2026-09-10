import PerspectiveGrid from './PerspectiveGrid';

/**
 * Empty-space backdrop for the landing page.
 * A static, fixed camera over a light-grey reference lattice — no marketing
 * text, no scroll-driven camera. The landing overlays float on top.
 */
const LandingScene = () => (
  <>
    <ambientLight intensity={2} />
    <PerspectiveGrid />
    <perspectiveCamera
      makeDefault
      fov={70}
      near={0.1}
      far={5000}
      position={[0, 0, 600]}
      aspect={window.innerWidth / window.innerHeight}
    />
  </>
);

export default LandingScene;