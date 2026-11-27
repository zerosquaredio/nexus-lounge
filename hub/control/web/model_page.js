//  The hub's page for one 3D model (/art/<short id>): wires the page's
//  Load 3D button to the viewer (model_viewer.js). The page names the model
//  file in its viewer element's data-model and its name in data-label;
//  nothing is fetched until the button is pressed. Without scripts the page
//  shows the model's preview picture and its description, and the button
//  stays hidden. Once the model is shown, the picture and the button
//  give way to it.

import { createModelViewer } from './model_viewer.js';

const container = document.getElementById('model-viewer');
const load = document.getElementById('model-load');
const stats = document.getElementById('model-stats');
const preview = document.getElementById('model-preview');
const ask = document.getElementById('model-ask');

if (container && load && container.dataset.model && container.dataset.model.startsWith('/assets/')) {
    let viewer = null;
    //  the picture gives way to the model once it is there
    new MutationObserver(() => {
        const state = container.dataset.state;
        const shown = state === 'ready';
        if (preview) {
            preview.hidden = shown;
        }
        if (ask) {
            ask.hidden = shown;
        }
        if (state === 'failed' || state === 'closed') {
            load.disabled = false;
        }
    }).observe(container, { attributes: true, attributeFilter: ['data-state'] });
    load.hidden = false;
    load.addEventListener('click', () => {
        if (!viewer || viewer.state() === 'closed') {
            viewer = createModelViewer(container, container.dataset.model, {
                stats,
                label: container.dataset.label || '',
            });
        }
        load.disabled = true;
        viewer.load();
    });
}
