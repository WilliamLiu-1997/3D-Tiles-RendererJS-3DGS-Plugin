# EXT_splat_opacity

`EXT_splat_opacity` is a draft, project-local glTF extension for
SPZ-compressed Gaussian splat primitives. Version 2 preserves merged source
opacity, including values above `1.0`, and the pre-boost shape information
required to retarget an already-applied coverage boost without iterative
reconstruction.

This is not a Khronos-ratified extension. It is intended for content using
`KHR_gaussian_splatting` with
`KHR_gaussian_splatting_compression_spz_2`. The SPZ payload remains a complete,
boosted fallback for readers that do not support this extension.

## Summary

| Field | Value |
| --- | --- |
| Extension name | `EXT_splat_opacity` |
| Current version | `2` |
| Opacity payload | IEEE 754 binary16 bits in an `UNSIGNED_SHORT` accessor |
| Shape payload | Pre-boost `sMid / sMax` in a normalized `UNSIGNED_SHORT` accessor |
| Converter layout | 4 payload bytes per splat |
| Splat order | Accessor element `i` applies to decoded SPZ splat `i` |
| Fallback | Use the opacity and boosted scales decoded from SPZ |

Source opacity is not glTF material opacity and is not premultiplied into
color. It is the merged per-splat opacity before coverage compensation or a
renderer-specific high-opacity encoding.

## Extension Placement

Producers should place `EXT_splat_opacity` inside the
`KHR_gaussian_splatting.extensions` object on the primitive:

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
                  "version": 2,
                  "sourceOpacityAccessor": 0,
                  "sourceOpacityEncoding": "float16",
                  "coverageBoostRatioAccessor": 1,
                  "coverageBoostMethod": "opacity_anisotropic_v1",
                  "coverageBoostScale": 0.75
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

When the boosted SPZ representation is an acceptable fallback, producers list
`EXT_splat_opacity` in `extensionsUsed` but not `extensionsRequired`. An
unsupported reader then ignores the extension and retains both SPZ-decoded
opacity and SPZ-decoded scales.

Legacy project content may place version 1 directly in
`primitive.extensions`. Readers may accept that placement for compatibility,
but new producers should use the nested placement shown above.

## Version 2 Extension Object

```ts
type ExtSplatOpacityV2 = {
  version: 2;
  sourceOpacityAccessor: number;
  sourceOpacityEncoding: "float16";
  coverageBoostRatioAccessor: number;
  coverageBoostMethod: "opacity_anisotropic_v1";
  coverageBoostScale: number;
};
```

All six fields are required. Accessor indices must be non-negative integers,
and `coverageBoostScale` must be finite and non-negative.

### `sourceOpacityAccessor`

This accessor stores one source opacity value per decoded splat. It must use:

- `componentType: 5123` (`UNSIGNED_SHORT`)
- `type: "SCALAR"`
- `normalized` omitted or `false`
- `count` equal to the decoded SPZ splat count

Because `sourceOpacityEncoding` is `"float16"`, readers reinterpret each
unsigned 16-bit component as an IEEE 754 binary16 bit pattern; they do not
convert the integer numerically. For example, `0x3c00` represents `1.0`.

Producers round source opacity to the nearest binary16 value, with ties to even,
and clamp finite values to `[0, 65504]`. A decoded value must be finite and
non-negative. A reader leaves the corresponding splat at its SPZ fallback when
it encounters NaN, infinity, or a negative binary16 value.

### `coverageBoostRatioAccessor`

This accessor stores the pre-boost shape ratio

```math
r = \frac{s_{mid}}{s_{max}},
```

where `sMid` and `sMax` are the middle and largest of the three positive linear
scale axes before coverage boost. It must use:

- `componentType: 5123` (`UNSIGNED_SHORT`)
- `type: "SCALAR"`
- `normalized: true`
- `count` equal to the decoded SPZ splat count

The producer writes

```math
q = \operatorname{round}(\operatorname{clamp}(r,0,1)\,65535).
```

A reader operating on raw components recovers `r` as `q / 65535`; a glTF
loader that applies accessor normalization may already expose that normalized
value. For log-scale input, the producer can calculate the ratio without
exponentiating every axis:

```math
r = \exp(\log s_{mid} - \log s_{max}).
```

### `coverageBoostMethod`

`"opacity_anisotropic_v1"` identifies the exact scale-growth and opacity
compensation formulas defined below. A reader must ignore the complete version
2 payload when it does not recognize this method.

### `coverageBoostScale`

This value records the strength already applied to the scales encoded in SPZ.
A value of `0` means those scales are unboosted. It describes producer state;
it is not a required reader preference.

## Accessor Storage

Normal glTF accessor and buffer-bound rules apply. Sparse accessors are not
supported. Readers must honor `bufferView.byteOffset`, `bufferView.byteStride`,
and `accessor.byteOffset`, and must read component bytes as little-endian glTF
data.

The converter interleaves both unsigned 16-bit values in one buffer view:

```text
sourceOpacity16, coverageBoostRatio16,
sourceOpacity16, coverageBoostRatio16,
...
```

The shared buffer view has `byteStride: 4`. The source-opacity accessor uses
`byteOffset: 0`, and the ratio accessor uses `byteOffset: 2`. This is exactly
4 payload bytes per splat, excluding one-time glTF metadata and alignment.
Readers can expose both accessors as lightweight strided views over the loaded
GLB bytes and process them sequentially, without copying or deinterleaving the
payload.

Conforming producers give both accessors the decoded SPZ splat count. A
tolerant reader may restrict application to the minimum safe count across both
accessors, the decoded SPZ splat count, and its decoded storage; unmatched
splats retain their SPZ fallback values.

## `opacity_anisotropic_v1` Boost Model

For source opacity `alpha`, boost strength `c`, and pre-boost ratio `r`, define:

```math
F(c) =
\begin{cases}
1, & \alpha \le 1,\\
1+c\left(\sqrt{\min(\alpha,1000)}-1\right), & \alpha>1,
\end{cases}
```

```math
D = 1-r+r^2,
\qquad
G(c) = 1 + \frac{(F(c)-1)r}{D}.
```

The producer multiplies the largest pre-boost scale axis by `G(c)` and the
other two axes by `F(c)`. The largest axis remains a largest axis after this
transform. If quantization creates a tie, selecting any tied largest axis is
equivalent within source-opacity, ratio, and SPZ quantization error.

The producer applies the model using its unquantized source opacity. A reader
uses the binary16 value from `sourceOpacityAccessor`, so exact reconstruction is
subject to binary16 opacity, normalized-ratio, and SPZ scale quantization.

## Reader Retargeting

The reader first decodes SPZ, then optionally changes how much of the recorded
boost it retains. Let `cFile` be `coverageBoostScale`. A reader-selected target
must satisfy:

```math
0 \le cTarget \le cFile.
```

`cTarget = cFile` retains the complete recorded boost, while `cTarget = 0`
removes it. If a reader preference exceeds `cFile`, the reader should clamp it
to `cFile` instead of adding boost that was not recorded by the producer.

For each splat whose decoded source opacity is greater than `1`:

1. Decode `alpha` and `r` from the two accessors.
2. Identify the largest SPZ-decoded scale axis.
3. Multiply that axis by `G(cTarget) / G(cFile)`.
4. Multiply the other axes by `F(cTarget) / F(cFile)`.

Equivalently:

```math
s_{max,target}=s_{max,file}\frac{G(cTarget)}{G(cFile)},
```

```math
s_{rest,target}=s_{rest,file}\frac{F(cTarget)}{F(cFile)}.
```

A reader storing logarithmic scales can add deltas directly:

```math
\Delta_{max}=\ln\frac{G(cTarget)}{G(cFile)},
\qquad
\Delta_{rest}=\ln\frac{F(cTarget)}{F(cFile)}.
```

This is constant work per splat and requires no root solver or iterative
inverse. Splats whose source opacity is less than or equal to `1` retain their
SPZ-decoded opacity and scales.

## Coverage-Compensated Opacity

For `0 <= r <= 1`, `F(cTarget) >= G(cTarget)`, so the two largest axis-growth
factors are the two `F(cTarget)` factors. The method's retained coverage-area
factor is therefore `F(cTarget)^2`. The renderer-facing opacity before any
renderer-specific high-opacity encoding is:

```math
\alpha_{display}
=
\frac{\alpha}{F(cTarget)^2}.
```

This compensation is applied only to source opacity above `1`; other splats
retain the SPZ-decoded opacity.

### Gaussian Splat Lite high-opacity profile

Gaussian Splat Lite `0.1.2` and later stores alpha and wider-kernel shape amount in the
low and high binary16 lanes of the first record's final word. For
`alphaDisplay <= 1`, the reader writes `alphaDisplay` to the low lane and zero
to the high lane. For `alphaDisplay > 1`, it writes `1` to the low lane and:

```math
S(x)
=
\frac{\sqrt{1+e\ln(\operatorname{clamp}(x,0,1000))}-1}{4}
```

to the high lane. This preserves standard render-time alpha independently from
the nonlinear wider-kernel shape amount. Raw source-opacity bits must not be
copied directly into either lane.

Other renderers may consume `alphaDisplay` according to their own opacity
representation; the two-lane `S` mapping is specific to the Gaussian Splat Lite
profile.

## Invalid, Unknown, or Unavailable Version 2 Data

Version 2 is optional. A reader keeps the complete decoded SPZ fallback when
any of these conditions applies:

- `version` is unknown
- `sourceOpacityEncoding` or `coverageBoostMethod` is unknown
- a required field is missing or invalid
- either accessor is malformed, unavailable, or out of bounds
- `coverageBoostScale` is negative or non-finite

Readers validate the complete metadata and accessor layout before modifying
decoded storage. After that validation succeeds, each matched splat can be
processed independently in one pass. An invalid source opacity or computed
opacity/scale update leaves that splat's SPZ-decoded opacity and boosted scales
unchanged; it does not prevent other valid splats from using version 2. A reader
must validate the complete update for one splat before writing any part of it,
so a single splat is never partially modified. If a reader tolerates shorter
counts, unmatched splats remain untouched as described in Accessor Storage.

## Legacy Version 1

A legacy version 1 object has either no `version` field or `version: 1`, plus an
`opacityAccessor` field:

```ts
type ExtSplatOpacityV1 = {
  version?: 1;
  opacityAccessor: number;
};
```

The referenced accessor contains display-ready encoded opacity and uses:

- `componentType: 5126` (`FLOAT`)
- `type: "SCALAR"`
- `normalized` omitted or `false`
- one finite, non-negative value per decoded splat

A version 1 reader overwrites opacity after SPZ decode and does not retarget
scales. A Gaussian Splat Lite `0.1.3` reader converts a value above `1` by
writing alpha `1` to the low binary16 lane and `opacity - 1` to the high
shape-amount lane. Version 2 deliberately uses `sourceOpacityAccessor` rather
than reusing `opacityAccessor`, allowing a legacy reader to ignore v2 instead
of interpreting unsigned-short source data as display-ready float opacity.

## Producer Checklist

- Emit version 2 only when at least one source opacity is greater than `1`.
- Write both accessors in decoded SPZ splat order with matching counts.
- Calculate `sMid / sMax` from positive linear scales before coverage boost.
- Record the actual boost method and strength applied to the SPZ scales.
- Keep the already-boosted SPZ payload usable without the extension.
- Use `extensionsUsed`, not `extensionsRequired`, when SPZ fallback is intended.
