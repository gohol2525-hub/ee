# CAD fixtures

- `workshop.dxf`: hand-authored ASCII DXF (millimetres), with Vietnamese text,
  layers, a hidden layer, a block with a nonzero base, a circle and a bulged
  polyline. Used by the geometry / plot tests.
- `entities-2d.dwg`: genuine DWG 2000 from GNU LibreDWG's
  [test/test-data/2000/entities-2d.dwg](https://github.com/LibreDWG/libredwg/blob/1f7419c35c483078cf895d89ce833f2441356169/test/test-data/2000/entities-2d.dwg).
  Distributed under GPL-3.0 with upstream LibreDWG. License is in
  `public/cad-assets/GPL-3.0.txt`. Used to verify the real WASM decode path,
  not an ASCII DXF renamed to DWG.
