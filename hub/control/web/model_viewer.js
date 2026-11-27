//  The hub's 3D model viewer: shows one .glb model in a page, to be turned,
//  zoomed and played. A plain module the browser runs as it is: no build
//  step, nothing fetched but the model itself (docs/development/
//  build_3d_slice.md, decision 1 and §5). It comes with model_file.js beside
//  it, which reads the model's own description before the 3D library does.
//
//  What it asks of the page's Content-Security-Policy, and nothing more:
//
//      script-src 'self'     this file and the copy of three.js beside it
//                            (../vendor/three), all from the hub's own address
//      connect-src 'self'    the one fetch of the model file
//      img-src blob:         pictures inside the model: the loader hands each
//                            to an <img> as a blob: address made in the page
//
//  It needs no style-src: every style it sets goes through an element's
//  style object, which a policy does not govern, and it writes no style
//  attribute and no <style>. It uses no eval, no workers and no WebAssembly,
//  so the policy needs no 'unsafe-eval', 'wasm-unsafe-eval' or worker-src.
//
//  The loader would by itself read those pictures with fetch() where the
//  browser can decode them off the main thread, which needs blob: in
//  connect-src. The viewer tells it to use <img> instead (useImageElements,
//  below), so connect-src stays at 'self'.
//
//  Use:
//
//      import { createModelViewer } from './model_viewer.js';
//      const viewer = createModelViewer(container, '/art/file/<hash>.glb',
//          { stats: element, label: "the model's name" });
//      button.addEventListener('click', () => viewer.load());
//      ...
//      viewer.dispose();
//
//  Nothing is fetched or drawn until load() is called. The viewer puts its
//  own elements inside the container (a status line, the canvas, a row of
//  buttons) and takes them out again on dispose(). The container's
//  data-state says where it is: "idle", "loading", "ready", "failed" or
//  "closed". The canvas is see-through, so the page's own background shows
//  behind the model in whatever colours the page has.
//
//  The canvas takes keys (arrows, plus, minus, Home), so a screen reader is
//  told it is an application and passes the keys on. It is named "3D model",
//  with the label after it when the page gives one, and described by a line
//  of key help the viewer keeps hidden beside it. A picture cannot be read
//  out: the page should keep the model's description as text near by.
//
//  Classes for the page to style: model-viewer-status, model-viewer-canvas,
//  model-viewer-keys (the hidden help line), model-viewer-buttons.
//
//  Below the model: a button for each animation and Pause, if it has any,
//  then Reset view (as Home does) and Full screen. Full screen is the
//  browser's own where it lets a page have it; where it doesn't (an
//  iPhone's Safari gives it only to video), the viewer fills the window
//  instead, over the page, until the button is pressed again or Escape.
//  Either way the container's data-expanded is "true" while it lasts.

import {
    AnimationMixer,
    Box3,
    DirectionalLight,
    HemisphereLight,
    LoadingManager,
    LoopRepeat,
    PerspectiveCamera,
    Scene,
    Sphere,
    Spherical,
    TextureLoader,
    Vector3,
    WebGLRenderer,
} from '../vendor/three/build/three.module.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from '../vendor/three/examples/jsm/controls/OrbitControls.js';
import { addressesNamed, animationLabel, modelJson } from './model_file.js';

//  the camera's angle of view, top to bottom, in degrees
const FieldOfView = 40;
//  sharper screens are drawn at no more than this many pixels to a CSS pixel,
//  which keeps phones with very dense screens from drawing nine times over
const MaxPixelRatio = 2;
//  one press of an arrow key turns the model this far, in radians
const KeyTurn = Math.PI / 24;
//  one press of + or - moves the camera to this share of its distance
const KeyZoom = 0.85;
//  the frames-per-second figure is the mean of this many latest frames
const FrameWindow = 60;
//  and is written to the page this often, in milliseconds
const StatsEvery = 500;

const Messages = {
    loading: 'Loading the model…',
    failed: 'This model could not be loaded.',
    noWebGL: 'This browser or device cannot show 3D models here.',
    lost: 'The 3D view stopped: the device took its graphics memory back. Load the page again to see the model.',
    name: '3D model',
    keys: 'Arrow keys turn the model, plus and minus zoom, Home puts it back.',
    reset: 'Reset view',
    expand: 'Full screen',
    shrink: 'Exit full screen',
};

//  each viewer's line of key help needs an id of its own in the page
let viewersMade = 0;

//  the loader's plugin hook, used for one thing: pictures inside the model go
//  through <img> (img-src blob:) and not fetch() (which would need
//  connect-src blob:)
function useImageElements(parser) {
    parser.textureLoader = new TextureLoader(parser.options.manager);
    return { name: 'HUB_image_elements' };
}

function freeMaterial(material) {
    for (const value of Object.values(material)) {
        if (value && value.isTexture) {
            const image = value.image;
            value.dispose();
            if (image && typeof image.close === 'function') {
                image.close();
            }
        }
    }
    material.dispose();
}

//  hands back everything a loaded model holds on the graphics card
function freeModel(root) {
    root.traverse(object => {
        if (object.geometry) {
            object.geometry.dispose();
        }
        if (object.skeleton) {
            object.skeleton.dispose();
        }
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
            if (material) {
                freeMaterial(material);
            }
        }
    });
}

export function createModelViewer(container, url, options = {}) {
    const statsElement = options.stats || null;
    //  the model's name, from the page, for the canvas's spoken name
    const label = typeof options.label === 'string' ? options.label.replace(/\s+/g, ' ').trim() : '';
    const keysId = `model-viewer-keys-${++viewersMade}`;
    const doc = container.ownerDocument;
    const view = doc.defaultView;

    let state = 'idle';
    let abort = null;
    let status = null;
    let canvas = null;
    let keysHelp = null;
    let buttonRow = null;
    let pauseButton = null;
    let expandButton = null;
    let animationButtons = [];
    //  while filling the screen: how, and the styles it replaced
    let expanded = null;
    let renderer = null;
    let scene = null;
    let camera = null;
    let controls = null;
    let resizeWatch = null;
    let root = null;
    let mixer = null;
    let clips = [];
    let current = -1;
    let playing = false;
    let frameRequest = 0;
    let needsDraw = false;
    let lastTick = 0;
    let lastDrawn = false;
    let frameTimes = [];
    let statsWritten = 0;
    let home = null;
    const figures = { loadMs: null, bytes: null, fps: null, triangles: null, drawCalls: null };

    function setState(next) {
        state = next;
        container.dataset.state = next;
    }

    function say(text) {
        if (!status) {
            status = doc.createElement('p');
            status.className = 'model-viewer-status';
            status.setAttribute('role', 'status');
            container.prepend(status);
        }
        status.textContent = text;
        status.hidden = text === '';
    }

    function writeStats() {
        if (!statsElement) {
            return;
        }
        const parts = [];
        if (figures.loadMs !== null) {
            parts.push(`Loaded in ${Math.round(figures.loadMs)} ms (${Math.ceil(figures.bytes / 1024)} kB).`);
            statsElement.dataset.loadMs = String(Math.round(figures.loadMs));
            statsElement.dataset.bytes = String(figures.bytes);
        }
        if (figures.fps !== null) {
            parts.push(`${Math.round(figures.fps)} frames a second.`);
            statsElement.dataset.fps = figures.fps.toFixed(1);
        }
        if (figures.triangles !== null) {
            parts.push(`${figures.triangles} triangles in ${figures.drawCalls} draw calls.`);
            statsElement.dataset.triangles = String(figures.triangles);
            statsElement.dataset.drawCalls = String(figures.drawCalls);
        }
        statsElement.textContent = parts.join(' ');
    }

    function clearStats() {
        if (!statsElement) {
            return;
        }
        statsElement.textContent = '';
        for (const key of ['loadMs', 'bytes', 'fps', 'triangles', 'drawCalls']) {
            delete statsElement.dataset[key];
        }
    }

    //  the canvas's size on the page, in CSS pixels, to the drawing's size
    function fitToPage() {
        if (!renderer || !canvas) {
            return;
        }
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (width === 0 || height === 0) {
            return;
        }
        renderer.setPixelRatio(Math.min(view.devicePixelRatio || 1, MaxPixelRatio));
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        needsDraw = true;
    }

    //  puts the camera where the whole model fits the view, whatever its size
    //  and wherever its maker put it, and remembers that place for Home
    function frameModel() {
        const box = new Box3().setFromObject(root);
        const sphere = new Sphere(new Vector3(), 1);
        if (!box.isEmpty()) {
            box.getBoundingSphere(sphere);
        }
        const radius = sphere.radius > 0 && Number.isFinite(sphere.radius) ? sphere.radius : 1;
        const halfHeight = (FieldOfView / 2) * (Math.PI / 180);
        const halfWidth = Math.atan(Math.tan(halfHeight) * (camera.aspect || 1));
        const distance = (radius / Math.sin(Math.min(halfHeight, halfWidth))) * 1.05;
        const direction = new Vector3(1, 0.6, 1.6).normalize();
        camera.near = distance / 100;
        camera.far = distance * 100;
        camera.position.copy(sphere.center).addScaledVector(direction, distance);
        camera.updateProjectionMatrix();
        controls.target.copy(sphere.center);
        controls.minDistance = radius * 0.2;
        controls.maxDistance = distance * 5;
        controls.update();
        home = { position: camera.position.clone(), target: sphere.center.clone(), radius };
        needsDraw = true;
    }

    //  the lights are the viewer's own and the same for every model: a soft
    //  light from all round, brighter from above, and one plain white lamp
    function addLights() {
        const sky = new HemisphereLight(0xffffff, 0x8c8c8c, 2.2);
        const lamp = new DirectionalLight(0xffffff, 2.4);
        lamp.position.set(1.5, 3, 2.5);
        scene.add(sky, lamp);
    }

    function showButtons() {
        for (let index = 0; index < animationButtons.length; index++) {
            animationButtons[index].setAttribute('aria-pressed', index === current ? 'true' : 'false');
        }
        if (pauseButton) {
            pauseButton.textContent = playing ? 'Pause' : 'Play';
        }
    }

    //  starts one animation from its beginning, looping, in place of whichever
    //  was running. With moving false it is put in its first pose and held
    function chooseAnimation(index, moving) {
        mixer.stopAllAction();
        const action = mixer.clipAction(clips[index]);
        action.setLoop(LoopRepeat, Infinity);
        action.reset().play();
        mixer.update(0);
        current = index;
        playing = moving;
        needsDraw = true;
        showButtons();
    }

    //  the camera back where it started, the whole model in view
    function resetView() {
        if (!controls || !home) {
            return;
        }
        camera.position.copy(home.position);
        controls.target.copy(home.target);
        controls.update();
        needsDraw = true;
    }

    //  the styles the viewer sets to fill the screen, and on what
    function fillStyles() {
        return [
            [
                container,
                {
                    position: 'fixed',
                    inset: '0',
                    zIndex: '2147483647',
                    margin: '0',
                    display: 'flex',
                    flexDirection: 'column',
                    boxSizing: 'border-box',
                    padding:
                        'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)',
                    background: view.getComputedStyle(doc.body).backgroundColor || 'Canvas',
                },
            ],
            [
                canvas,
                {
                    flex: '1 1 0',
                    minHeight: '0',
                    maxHeight: 'none',
                    width: '100%',
                    height: 'auto',
                    aspectRatio: 'auto',
                },
            ],
            [doc.documentElement, { overflow: 'hidden' }],
        ];
    }

    function setStyles(list) {
        const before = [];
        for (const [element, styles] of list) {
            const kept = {};
            for (const [name, value] of Object.entries(styles)) {
                kept[name] = element.style[name];
                element.style[name] = value;
            }
            before.push([element, kept]);
        }
        return before;
    }

    //  fill the screen, or stop filling it
    function expand(on) {
        if (on === !!expanded || !canvas) {
            return;
        }
        if (on) {
            expanded = { native: false, before: setStyles(fillStyles()) };
            container.dataset.expanded = 'true';
            if (doc.fullscreenEnabled && typeof container.requestFullscreen === 'function') {
                expanded.native = true;
                //  refused (no gesture, a policy): it stays filling the window
                container.requestFullscreen().catch(() => {
                    if (expanded) {
                        expanded.native = false;
                    }
                });
            }
            doc.addEventListener('keydown', onEscape);
        } else {
            const was = expanded;
            expanded = null;
            setStyles(was.before);
            delete container.dataset.expanded;
            doc.removeEventListener('keydown', onEscape);
            if (was.native && doc.fullscreenElement === container) {
                doc.exitFullscreen().catch(() => {});
            }
        }
        if (expandButton) {
            expandButton.textContent = on ? Messages.shrink : Messages.expand;
            expandButton.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        //  once the new size has taken, the camera placed again for its
        //  shape: a view framed for a wide box cuts a model off on a tall one
        view.requestAnimationFrame(() =>
            view.requestAnimationFrame(() => {
                if (controls && root) {
                    fitToPage();
                    frameModel();
                }
            })
        );
        needsDraw = true;
    }

    //  the browser's full screen ended its own way (Escape, a gesture)
    function onFullscreenChange() {
        if (expanded && expanded.native && doc.fullscreenElement !== container) {
            expand(false);
        }
    }

    //  Escape ends filling the window, as it ends the browser's full screen
    function onEscape(event) {
        if (event.key === 'Escape' && expanded && !expanded.native) {
            expand(false);
        }
    }

    function makeButtons() {
        buttonRow = doc.createElement('div');
        buttonRow.className = 'model-viewer-buttons';
        const viewButtons = () => {
            const reset = doc.createElement('button');
            reset.type = 'button';
            reset.textContent = Messages.reset;
            reset.addEventListener('click', resetView);
            expandButton = doc.createElement('button');
            expandButton.type = 'button';
            expandButton.textContent = Messages.expand;
            expandButton.setAttribute('aria-pressed', 'false');
            expandButton.addEventListener('click', () => expand(!expanded));
            buttonRow.append(reset, expandButton);
        };
        if (clips.length === 0) {
            viewButtons();
            container.append(buttonRow);
            return;
        }
        clips.forEach((clip, index) => {
            const button = doc.createElement('button');
            button.type = 'button';
            //  the name is the model maker's own words: shown as text, never
            //  as markup, and never left blank or overlong
            button.textContent = animationLabel(clip.name, index);
            button.addEventListener('click', () => chooseAnimation(index, true));
            animationButtons.push(button);
            buttonRow.append(button);
        });
        pauseButton = doc.createElement('button');
        pauseButton.type = 'button';
        pauseButton.addEventListener('click', () => {
            playing = !playing;
            needsDraw = true;
            showButtons();
        });
        buttonRow.append(pauseButton);
        viewButtons();
        container.append(buttonRow);
    }

    //  turning and zooming from the keyboard, done here and not by the
    //  controls, whose own arrow keys slide the view sideways
    function onKey(event) {
        if (!controls || event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }
        const offset = camera.position.clone().sub(controls.target);
        const round = new Spherical().setFromVector3(offset);
        switch (event.key) {
            case 'ArrowLeft':
                round.theta -= KeyTurn;
                break;
            case 'ArrowRight':
                round.theta += KeyTurn;
                break;
            case 'ArrowUp':
                round.phi -= KeyTurn;
                break;
            case 'ArrowDown':
                round.phi += KeyTurn;
                break;
            case '+':
            case '=':
                round.radius *= KeyZoom;
                break;
            case '-':
            case '_':
                round.radius /= KeyZoom;
                break;
            case 'Home':
                resetView();
                event.preventDefault();
                return;
            default:
                return;
        }
        event.preventDefault();
        round.makeSafe();
        round.radius = Math.min(Math.max(round.radius, controls.minDistance), controls.maxDistance);
        camera.position.copy(controls.target).add(offset.setFromSpherical(round));
        controls.update();
        needsDraw = true;
    }

    //  one turn of the browser's drawing clock. The scene is drawn again only
    //  when something moved, so a still model costs nothing while it is left
    //  alone; the frames-per-second figure counts only frames drawn back to back
    function tick(now) {
        frameRequest = view.requestAnimationFrame(tick);
        const elapsed = lastTick === 0 ? 0 : now - lastTick;
        lastTick = now;
        if (playing && mixer) {
            //  a tab left in the background comes back with one very long
            //  step, which is not played out
            mixer.update(Math.min(elapsed, 250) / 1000);
            needsDraw = true;
        }
        controls.update();
        if (!needsDraw) {
            lastDrawn = false;
            return;
        }
        needsDraw = false;
        renderer.render(scene, camera);
        if (lastDrawn && elapsed > 0) {
            frameTimes.push(elapsed);
            if (frameTimes.length > FrameWindow) {
                frameTimes.shift();
            }
        }
        lastDrawn = true;
        figures.triangles = renderer.info.render.triangles;
        figures.drawCalls = renderer.info.render.calls;
        if (now - statsWritten >= StatsEvery) {
            statsWritten = now;
            if (frameTimes.length >= 5) {
                const mean = frameTimes.reduce((sum, time) => sum + time, 0) / frameTimes.length;
                figures.fps = 1000 / mean;
            }
            writeStats();
        }
    }

    function onContextLost() {
        //  not asked to come back: the model's data went with it, and the
        //  person can load the page again
        release();
        setState('failed');
        say(Messages.lost);
    }

    //  frees everything the viewer holds, leaving only the status line
    function release() {
        if (expanded) {
            expand(false);
        }
        doc.removeEventListener('fullscreenchange', onFullscreenChange);
        if (abort) {
            abort.abort();
            abort = null;
        }
        if (frameRequest) {
            view.cancelAnimationFrame(frameRequest);
            frameRequest = 0;
        }
        if (resizeWatch) {
            resizeWatch.disconnect();
            resizeWatch = null;
        }
        if (mixer) {
            mixer.stopAllAction();
            if (root) {
                mixer.uncacheRoot(root);
            }
            mixer = null;
        }
        if (root) {
            freeModel(root);
            root = null;
        }
        if (controls) {
            controls.dispose();
            controls = null;
        }
        if (canvas) {
            canvas.removeEventListener('webglcontextlost', onContextLost);
            canvas.removeEventListener('keydown', onKey);
        }
        if (renderer) {
            renderer.dispose();
            //  gives the graphics memory back now, not when the page goes
            if (!renderer.getContext().isContextLost()) {
                renderer.forceContextLoss();
            }
            renderer = null;
        }
        if (canvas) {
            canvas.remove();
            canvas = null;
        }
        if (keysHelp) {
            keysHelp.remove();
            keysHelp = null;
        }
        if (buttonRow) {
            buttonRow.remove();
            buttonRow = null;
        }
        pauseButton = null;
        expandButton = null;
        animationButtons = [];
        scene = null;
        camera = null;
        clips = [];
        current = -1;
        playing = false;
        needsDraw = false;
        lastTick = 0;
        lastDrawn = false;
        frameTimes = [];
        home = null;
    }

    function fail(message, error) {
        release();
        setState('failed');
        say(message);
        if (error) {
            console.error('model viewer:', error);
        }
    }

    function makeCanvas() {
        canvas = doc.createElement('canvas');
        canvas.className = 'model-viewer-canvas';
        canvas.tabIndex = 0;
        //  not role "img": a screen reader keeps the arrow keys for itself
        //  over a picture, and here they turn the model
        canvas.setAttribute('role', 'application');
        canvas.setAttribute('aria-label', label === '' ? Messages.name : `${Messages.name}: ${label}`);
        canvas.setAttribute('aria-describedby', keysId);
        //  set through the style object, which needs no style-src. A page's
        //  own stylesheet can give the canvas another shape with !important
        canvas.style.display = 'none';
        canvas.style.width = '100%';
        canvas.style.aspectRatio = '4 / 3';
        canvas.style.maxHeight = '80vh';
        //  hidden, and still read out as the canvas's description
        keysHelp = doc.createElement('p');
        keysHelp.id = keysId;
        keysHelp.className = 'model-viewer-keys';
        keysHelp.hidden = true;
        keysHelp.textContent = Messages.keys;
        container.append(canvas, keysHelp);
    }

    async function load() {
        if (state !== 'idle' && state !== 'failed') {
            return;
        }
        release();
        setState('loading');
        say(Messages.loading);
        clearStats();
        const started = view.performance.now();
        abort = new AbortController();
        const signal = abort.signal;

        makeCanvas();
        try {
            //  alpha: the page's background shows through, in the page's colours
            renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
        } catch (error) {
            fail(Messages.noWebGL, error);
            return;
        }
        renderer.setClearColor(0x000000, 0);
        canvas.addEventListener('webglcontextlost', onContextLost);

        let gltf;
        let bytes;
        try {
            const response = await view.fetch(url, {
                signal,
                credentials: 'same-origin',
                redirect: 'error',
            });
            if (!response.ok) {
                throw new Error(`the model's address answered ${response.status}`);
            }
            const data = await response.arrayBuffer();
            bytes = data.byteLength;
            //  a model is one file, with everything inside it. The hub's
            //  checker refuses any model that names an address; this is the
            //  same rule held again in the page, two ways. First from the
            //  file's own description, before the loader sees it: a buffer
            //  or picture with a uri of any kind, and the model is not shown
            const named = addressesNamed(modelJson(data));
            if (named.length > 0) {
                throw new Error(`the model names an address outside its own file (${named.join(', ')})`);
            }
            //  and then in the loader, which may open only the blob:
            //  addresses it makes itself. A model that asks for anything
            //  else is not shown at all (left alone, the loader would show
            //  it without the picture it could not get)
            let outside = null;
            const manager = new LoadingManager();
            manager.setURLModifier(address => {
                if (typeof address === 'string' && address.startsWith('blob:')) {
                    return address;
                }
                outside = outside || new Error('the model names an address outside its own file');
                throw outside;
            });
            const loader = new GLTFLoader(manager);
            loader.register(useImageElements);
            gltf = await loader.parseAsync(data, '');
            if (outside) {
                if (gltf.scene) {
                    freeModel(gltf.scene);
                }
                throw outside;
            }
        } catch (error) {
            if (signal.aborted) {
                return;
            }
            fail(Messages.failed, error);
            return;
        }
        if (signal.aborted) {
            //  disposed, or the graphics context lost, while the model was read
            if (gltf && gltf.scene) {
                freeModel(gltf.scene);
            }
            return;
        }
        abort = null;

        //  the model is read; now it is set up and drawn. Anything that goes
        //  wrong here ends the same way as a model that could not be read,
        //  and not with the page left saying "Loading" for ever
        try {
            scene = new Scene();
            camera = new PerspectiveCamera(FieldOfView, 4 / 3, 0.1, 100);
            root = gltf.scene || new Scene();
            scene.add(root);
            addLights();

            const stillness = view.matchMedia('(prefers-reduced-motion: reduce)').matches;
            controls = new OrbitControls(camera, canvas);
            //  the view glides to a stop after a drag, except for people who have
            //  asked their device for less motion
            controls.enableDamping = !stillness;
            controls.addEventListener('change', () => {
                needsDraw = true;
            });

            canvas.style.display = 'block';
            fitToPage();
            frameModel();
            resizeWatch = new view.ResizeObserver(fitToPage);
            resizeWatch.observe(canvas);
            canvas.addEventListener('keydown', onKey);

            clips = gltf.animations || [];
            if (clips.length > 0) {
                mixer = new AnimationMixer(root);
            }
            makeButtons();
            doc.addEventListener('fullscreenchange', onFullscreenChange);
            if (clips.length > 0) {
                const idle = clips.findIndex(clip => clip.name === 'idle');
                chooseAnimation(idle === -1 ? 0 : idle, !stillness);
            }

            //  the first picture, so the load time counts the model being on screen
            renderer.render(scene, camera);
            figures.loadMs = view.performance.now() - started;
            figures.bytes = bytes;
            figures.fps = null;
            figures.triangles = renderer.info.render.triangles;
            figures.drawCalls = renderer.info.render.calls;
            writeStats();
            say('');
            setState('ready');
            frameRequest = view.requestAnimationFrame(tick);
        } catch (error) {
            if (!root && gltf.scene) {
                freeModel(gltf.scene);
            }
            fail(Messages.failed, error);
        }
    }

    function dispose() {
        release();
        if (status) {
            status.remove();
            status = null;
        }
        clearStats();
        setState('closed');
    }

    setState('idle');
    return {
        load,
        dispose,
        //  what was measured, for the trials: load time in milliseconds, the
        //  file's size, frames a second, and what the last frame drew
        figures: () => ({ ...figures }),
        state: () => state,
    };
}
