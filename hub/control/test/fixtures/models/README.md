# Sample models

Small 3D models for the hub's tests and for trying the viewer, each with
a preview picture. They are the project's own work, made from code, and
are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), like
the project's art (`art/README.md`). Credit them to "The Nexus Lounge
project".

| Model | Preview | What it is |
|---|---|---|
| `still.glb` | `still.png` | A ball of 288 triangles, coloured at each vertex. Nothing moves |
| `animated.glb` | `animated.png` | A stand, an arm and a ball (three parts, 172 triangles) with two animations: `idle` (6 seconds, the arm turns slowly and the ball bobs) and `spin` (1 second, the arm turns fast and the ball swells) |
| `skinned.glb` | `skinned.png` | A tube of 256 triangles on a chain of four bones, with one animation, `bend` (4 seconds), bending it one way and then the other |
| `textured.glb` | `textured.png` | A box with a chequered PNG picture of 64 by 64 pixels inside the file |

All are binary glTF 2.0 with everything inside the one file, no
extensions and no compression, and far inside the budget of class
`light`. Khronos's glTF validator finds no errors or warnings in them.

The previews are placeholders: plain cards in each model's colour, 256
pixels square. Nothing here can draw a model, so they are not pictures of
the models.

## Making them again

They are written by `../make_models.ts`, with the builder in
`../../glb.ts`. To change one, change the generator and run it from
`hub/control`:

    node test/fixtures/make_models.ts

and commit what it writes. The same code gives the same models every
time, and `test/glb.test.ts` fails if a file here is not what the
generator makes. Hostile models (wrong lengths, addresses outside the
file, models over the budget) are not kept as files: tests make them
with the `hostile` helpers of `glb.ts`.
