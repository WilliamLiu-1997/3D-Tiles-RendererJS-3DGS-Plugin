# EXT_splat_opacity

`EXT_splat_opacity` is a draft glTF extension used by this Gaussian splat
tile pipeline to carry Spark-compatible per-splat opacity values alongside
SPZ-compressed Gaussian splat data.

The extension is not a Khronos-ratified extension. It is a narrow compatibility
extension for content that uses `KHR_gaussian_splatting` with
`KHR_gaussian_splatting_compression_spz_2` and needs opacity values that cannot
be faithfully represented by the base SPZ payload.

## Motivation

SPZ-compressed Gaussian splat payloads can be decoded into Spark `ExtSplats`,
but some pipelines need to preserve the exact Spark opacity scalar used by the
renderer. In particular, Spark-compatible opacity may intentionally use values
above `1.0` for Spark's LoD / coverage opacity encoding. Generic alpha paths
often clamp opacity to `[0, 1]`, which loses that information.

`EXT_splat_opacity` stores those per-splat values in a normal glTF accessor.
Readers can decode the SPZ payload first, then patch the decoded Spark opacity
storage from the accessor before rendering.

## Extension Placement

The recommended placement is inside the `KHR_gaussian_splatting` extension on
the primitive:

```json
{
  "meshes": [
    {
      "primitives": [
        {
          "extensions": {
            "KHR_gaussian_splatting": {
              "extensions": {
                "KHR_gaussian_splatting_compression_spz_2": {
                  "bufferView": 0
                },
                "EXT_splat_opacity": {
                  "opacityAccessor": 0
                }
              }
            }
          }
        }
      ]
    }
  ],
  "extensionsUsed": [
    "KHR_gaussian_splatting",
    "KHR_gaussian_splatting_compression_spz_2",
    "EXT_splat_opacity"
  ]
}
```

For compatibility, `3d-tiles-rendererjs-3dgs-plugin` also accepts
`EXT_splat_opacity` directly on `primitive.extensions`, but producers should
prefer the nested form above because the data modifies the Gaussian splat
primitive, not the glTF material.

If the accessor values are required for faithful rendering, producers should
also list `EXT_splat_opacity` in `extensionsRequired`. If the base SPZ opacity
is an acceptable fallback, listing it only in `extensionsUsed` is sufficient.

## Extension Object

The extension object has one property:

```ts
type ExtSplatOpacity = {
  opacityAccessor?: number;
};
```

### `opacityAccessor`

`opacityAccessor` is the index of a glTF accessor containing one opacity value
per decoded splat.

The property may be omitted. An omitted accessor means the reader should use the
opacity already present in the SPZ payload.

## Accessor Requirements

The opacity accessor must satisfy these constraints:

- `componentType` must be `5126` (`FLOAT`).
- `type` must be `"SCALAR"`.
- `count` must be a non-negative integer.
- Sparse accessors are not supported.
- The accessor must reference a valid `bufferView`.
- The effective stride is `bufferView.byteStride ?? 4`.
- The effective stride must be at least `4` bytes.
- `accessor.byteOffset` and `bufferView.byteOffset` must be honored.
- The accessor range must stay inside the referenced `bufferView`.
- The referenced `bufferView` range must stay inside the backing buffer.

The accessor may be tightly packed or strided. A tightly packed, 4-byte aligned
accessor can be read as a zero-copy `Float32Array` view. Strided or unaligned
accessors should be read with `DataView.getFloat32(..., true)` and applied
directly, without first copying all values into a temporary array.

## Count and Splat Order

Accessor element `i` applies to decoded splat `i`.

Producers should make `accessor.count` exactly match the number of splats in the
SPZ payload. Readers may clamp the applied count to the minimum of:

- opacity accessor count
- decoded splat count
- available decoded Spark opacity storage

If the accessor is shorter than the decoded splat count, remaining splats keep
their SPZ-decoded opacity. If the accessor is longer, extra opacity values are
ignored.

## Value Semantics

Each value is a Spark-compatible opacity scalar for one splat.

Valid values are finite, non-negative `FLOAT` values. Producers must not emit
`NaN`, positive or negative infinity, or negative values. Readers may skip
invalid values and leave the corresponding SPZ-decoded opacity unchanged.

Values in `[0, 1]` behave like ordinary per-splat opacity. Values above `1.0`
are allowed and must not be clamped by readers that support this extension.
Spark uses the `> 1.0` range for its special LoD / coverage opacity encoding,
so preserving these values is the purpose of the extension.

The value is not a glTF material opacity and is not premultiplied into color.
It is a per-splat scalar applied after SPZ decode.

## Reader Behavior

A reader that supports this extension should:

1. Decode the `KHR_gaussian_splatting_compression_spz_2` payload.
2. Resolve and validate `opacityAccessor`, if present.
3. Initialize the renderer's splat data from the decoded SPZ payload.
4. Apply each valid opacity accessor value to the corresponding decoded splat.
5. Mark the renderer-side opacity texture or buffer dirty if any value was
   written.

In this plugin, the application step writes the half-float opacity value into
Spark's decoded `ExtSplats` extension array at word `i * 4 + 3`, then marks the
first Spark texture for upload.

Readers that do not support the extension can ignore it and render the base SPZ
opacity values.

## Minimal Example

```json
{
  "accessors": [
    {
      "bufferView": 1,
      "componentType": 5126,
      "count": 500000,
      "type": "SCALAR"
    }
  ],
  "bufferViews": [
    {
      "buffer": 0,
      "byteOffset": 0,
      "byteLength": 1234567
    },
    {
      "buffer": 0,
      "byteOffset": 1234568,
      "byteLength": 2000000
    }
  ],
  "meshes": [
    {
      "primitives": [
        {
          "extensions": {
            "KHR_gaussian_splatting": {
              "extensions": {
                "KHR_gaussian_splatting_compression_spz_2": {
                  "bufferView": 0
                },
                "EXT_splat_opacity": {
                  "opacityAccessor": 0
                }
              }
            }
          }
        }
      ]
    }
  ],
  "extensionsUsed": [
    "KHR_gaussian_splatting",
    "KHR_gaussian_splatting_compression_spz_2",
    "EXT_splat_opacity"
  ]
}
```

The first `bufferView` contains the SPZ payload. The second `bufferView`
contains `500000` little-endian `float32` opacity values in decoded splat order.

## Producer Guidance

- Emit `EXT_splat_opacity` only when the SPZ payload cannot preserve the opacity
  values needed by the target Spark renderer.
- Keep the accessor count equal to the decoded SPZ splat count.
- Use tightly packed `FLOAT` / `SCALAR` data when possible.
- Do not quantize, normalize, or clamp values above `1.0`.
- Put the extension inside `KHR_gaussian_splatting.extensions` unless a legacy
  reader requires primitive-level placement.

## Current Support

`3d-tiles-rendererjs-3dgs-plugin` supports this extension for glTF / GLB tile
payloads using `KHR_gaussian_splatting` with
`KHR_gaussian_splatting_compression_spz_2`. Raw, uncompressed Gaussian splat
primitives are not supported by this plugin.
