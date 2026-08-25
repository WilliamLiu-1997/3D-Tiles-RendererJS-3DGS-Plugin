use core::arch::wasm32::*;
use half::f16;
use std::cell::RefCell;

const UINT16_MAX: f32 = 65_535.0;
const FLOAT16_MAX: f32 = f16::MAX.to_f32_const();
const MAX_OPACITY: f32 = 1_000.0;
const E: f32 = core::f32::consts::E;
const LN_2: f32 = core::f32::consts::LN_2;

thread_local! {
    static WORKSPACE: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn opacity_workspace_reserve(byte_len: u32) -> u32 {
    let word_len = (byte_len as usize).div_ceil(size_of::<u32>());
    WORKSPACE.with_borrow_mut(|workspace| {
        workspace.resize(word_len, 0);
        workspace.as_mut_ptr() as u32
    })
}

#[inline]
unsafe fn read_u16_le(base: *const u8, byte_offset: usize) -> u16 {
    // SAFETY: The accessor loader validates bounds before the JS wrapper copies
    // the complete byte ranges into the workspace.
    u16::from_le(unsafe { base.add(byte_offset).cast::<u16>().read_unaligned() })
}

/// SIMD-friendly natural logarithm without a lookup table.
///
/// The input is split into a power of two and a mantissa in [1, 2). A seventh
/// degree Chebyshev approximation evaluates ln(mantissa) without division. Its
/// maximum absolute error over the interval is below 5e-7 while preserving
/// ln(1) = 0 exactly.
#[inline]
unsafe fn fast_ln(value: v128) -> v128 {
    let bits = value;
    let raw_exponent = v128_and(u32x4_shr(bits, 23), i32x4_splat(0xff));
    let exponent = i32x4_sub(raw_exponent, i32x4_splat(127));
    let mantissa_bits = v128_or(
        v128_and(bits, i32x4_splat(0x007f_ffff)),
        i32x4_splat(0x3f80_0000),
    );
    let fraction = f32x4_sub(mantissa_bits, f32x4_splat(1.0));
    let fraction_squared = f32x4_mul(fraction, fraction);
    let fraction_fourth = f32x4_mul(fraction_squared, fraction_squared);
    let pair_0 = f32x4_add(
        f32x4_splat(0.999_970_26),
        f32x4_mul(fraction, f32x4_splat(-0.499_333_95)),
    );
    let pair_1 = f32x4_add(
        f32x4_splat(0.327_511_7),
        f32x4_mul(fraction, f32x4_splat(-0.223_966_9)),
    );
    let pair_2 = f32x4_add(
        f32x4_splat(0.131_989_66),
        f32x4_mul(fraction, f32x4_splat(-0.053_267_48)),
    );
    let lower = f32x4_add(pair_0, f32x4_mul(fraction_squared, pair_1));
    let upper = f32x4_add(
        pair_2,
        f32x4_mul(fraction_squared, f32x4_splat(0.010_243_829)),
    );
    let polynomial = f32x4_mul(
        fraction,
        f32x4_add(lower, f32x4_mul(fraction_fourth, upper)),
    );
    f32x4_add(
        f32x4_mul(f32x4_convert_i32x4(exponent), f32x4_splat(LN_2)),
        polynomial,
    )
}

#[inline]
unsafe fn extract(value: v128, lane: usize) -> f32 {
    match lane {
        0 => f32x4_extract_lane::<0>(value),
        1 => f32x4_extract_lane::<1>(value),
        2 => f32x4_extract_lane::<2>(value),
        _ => f32x4_extract_lane::<3>(value),
    }
}

#[inline]
unsafe fn half4_normal_mask(bits: v128) -> v128 {
    let exponent = v128_and(bits, i32x4_splat(0x7c00));
    v128_and(
        i32x4_ne(exponent, i32x4_splat(0)),
        i32x4_ne(exponent, i32x4_splat(0x7c00)),
    )
}

#[inline]
unsafe fn half4_to_f32_normal(bits: v128) -> v128 {
    let sign = i32x4_shl(v128_and(bits, i32x4_splat(0x8000)), 16);
    let magnitude = v128_and(bits, i32x4_splat(0x7fff));
    v128_or(
        sign,
        i32x4_shl(i32x4_add(magnitude, i32x4_splat(0x1c000)), 13),
    )
}

#[inline]
unsafe fn f32x4_to_half_normal(value: v128) -> (v128, v128) {
    let bits = value;
    let sign = v128_and(u32x4_shr(bits, 16), i32x4_splat(0x8000));
    let exponent = i32x4_sub(
        v128_and(u32x4_shr(bits, 23), i32x4_splat(0xff)),
        i32x4_splat(112),
    );
    let normal_mask = v128_and(
        i32x4_gt(exponent, i32x4_splat(0)),
        i32x4_lt(exponent, i32x4_splat(0x1f)),
    );
    let mantissa = v128_and(bits, i32x4_splat(0x007f_ffff));
    let base = v128_or(
        sign,
        v128_or(i32x4_shl(exponent, 10), u32x4_shr(mantissa, 13)),
    );
    let round_mask = v128_and(
        i32x4_ne(v128_and(mantissa, i32x4_splat(0x1000)), i32x4_splat(0)),
        i32x4_ne(v128_and(mantissa, i32x4_splat(0x2fff)), i32x4_splat(0)),
    );
    let rounded = i32x4_add(base, v128_and(round_mask, i32x4_splat(1)));
    (rounded, normal_mask)
}

#[inline]
fn largest_scale_axis(x: f32, y: f32, z: f32) -> usize {
    if x >= y && x >= z {
        0
    } else if y >= z {
        1
    } else {
        2
    }
}

#[inline]
fn write_display_opacity(splat_a: &mut [u32], base: usize, opacity: f32) {
    splat_a[base + 3] = if opacity >= 2.0 {
        0x3c00_3c00
    } else if opacity > 1.0 {
        0x0000_3c00 | ((f16::from_f32(opacity - 1.0).to_bits() as u32) << 16)
    } else {
        f16::from_f32(opacity).to_bits() as u32
    };
}

#[inline]
fn write_scalar_fallback_lane(
    splat_a: &mut [u32],
    splat_b: &mut [u32],
    base: usize,
    rest_delta: f32,
    top_delta: f32,
    opacity: f32,
) {
    if rest_delta != 0.0 || top_delta != 0.0 {
        let scale_x = f16::from_bits((splat_b[base + 1] >> 16) as u16).to_f32();
        let scale_y = f16::from_bits(splat_b[base + 2] as u16).to_f32();
        let scale_z = f16::from_bits((splat_b[base + 2] >> 16) as u16).to_f32();
        let largest_axis = largest_scale_axis(scale_x, scale_y, scale_z);
        let updated_x = scale_x
            + if largest_axis == 0 {
                top_delta
            } else {
                rest_delta
            };
        let updated_y = scale_y
            + if largest_axis == 1 {
                top_delta
            } else {
                rest_delta
            };
        let updated_z = scale_z
            + if largest_axis == 2 {
                top_delta
            } else {
                rest_delta
            };
        if !updated_x.is_finite()
            || !updated_y.is_finite()
            || !updated_z.is_finite()
            || updated_x.abs() > FLOAT16_MAX
            || updated_y.abs() > FLOAT16_MAX
            || updated_z.abs() > FLOAT16_MAX
        {
            return;
        }

        let encoded_x = f16::from_f32(updated_x).to_bits() as u32;
        let encoded_y = f16::from_f32(updated_y).to_bits() as u32;
        let encoded_z = f16::from_f32(updated_z).to_bits() as u32;
        splat_b[base + 1] = (splat_b[base + 1] & 0x0000_ffff) | (encoded_x << 16);
        splat_b[base + 2] = encoded_y | (encoded_z << 16);
    }

    if opacity.is_finite() {
        write_display_opacity(splat_a, base, opacity);
    }
}

#[inline]
#[target_feature(enable = "simd128")]
unsafe fn write_display_opacity4(
    splat_a_ptr: *mut u32,
    display_opacity: v128,
    candidate_mask: v128,
) -> u32 {
    let shape_amount = f32x4_sub(display_opacity, f32x4_splat(1.0));
    let (encoded_shape, shape_normal_mask) = unsafe { f32x4_to_half_normal(shape_amount) };
    let fast_mask = v128_and(
        candidate_mask,
        v128_and(
            shape_normal_mask,
            v128_and(
                f32x4_gt(display_opacity, f32x4_splat(1.0)),
                f32x4_lt(display_opacity, f32x4_splat(2.0)),
            ),
        ),
    );
    let original = i32x4(
        unsafe { *splat_a_ptr.add(3) } as i32,
        unsafe { *splat_a_ptr.add(7) } as i32,
        unsafe { *splat_a_ptr.add(11) } as i32,
        unsafe { *splat_a_ptr.add(15) } as i32,
    );
    let encoded = v128_or(i32x4_splat(0x3c00), i32x4_shl(encoded_shape, 16));
    let final_opacity = v128_bitselect(encoded, original, fast_mask);
    unsafe {
        *splat_a_ptr.add(3) = i32x4_extract_lane::<0>(final_opacity) as u32;
        *splat_a_ptr.add(7) = i32x4_extract_lane::<1>(final_opacity) as u32;
        *splat_a_ptr.add(11) = i32x4_extract_lane::<2>(final_opacity) as u32;
        *splat_a_ptr.add(15) = i32x4_extract_lane::<3>(final_opacity) as u32;
    }
    i32x4_bitmask(fast_mask) as u32
}

#[target_feature(enable = "simd128")]
#[allow(clippy::too_many_arguments)]
unsafe fn retarget_impl(
    splat_a: &mut [u32],
    splat_b: &mut [u32],
    source_opacity: *const u8,
    source_stride: usize,
    ratio: *const u8,
    ratio_stride: usize,
    count: usize,
    file_scale: f32,
    target_scale: f32,
) {
    let file_scale_v = f32x4_splat(file_scale);
    let target_scale_v = f32x4_splat(target_scale);
    let one = f32x4_splat(1.0);

    for batch_base in (0..count).step_by(4) {
        let mut source_values = [1.0_f32; 4];
        let mut ratio_values = [0.0_f32; 4];
        let mut active_bits = 0_u32;
        let lane_count = (count - batch_base).min(4);

        for lane in 0..lane_count {
            let index = batch_base + lane;
            let source_bits = unsafe { read_u16_le(source_opacity, index * source_stride) };
            let source = f16::from_bits(source_bits).to_f32();
            if source.is_finite() && source > 1.0 {
                source_values[lane] = source;
                let ratio_bits = unsafe { read_u16_le(ratio, index * ratio_stride) };
                ratio_values[lane] = ratio_bits as f32 / UINT16_MAX;
                active_bits |= 1 << lane;
            }
        }
        if active_bits == 0 {
            continue;
        }

        let source_v = f32x4(
            source_values[0],
            source_values[1],
            source_values[2],
            source_values[3],
        );
        let ratio_v = f32x4(
            ratio_values[0],
            ratio_values[1],
            ratio_values[2],
            ratio_values[3],
        );
        let opacity_factor = f32x4_sub(
            f32x4_sqrt(f32x4_min(source_v, f32x4_splat(MAX_OPACITY))),
            one,
        );
        let file_rest = f32x4_add(one, f32x4_mul(file_scale_v, opacity_factor));
        let target_rest = f32x4_add(one, f32x4_mul(target_scale_v, opacity_factor));
        let rest_log_delta = unsafe { fast_ln(f32x4_div(target_rest, file_rest)) };

        let ratio_factor = f32x4_div(
            ratio_v,
            f32x4_add(f32x4_sub(one, ratio_v), f32x4_mul(ratio_v, ratio_v)),
        );
        let file_top = f32x4_add(
            one,
            f32x4_mul(f32x4_mul(file_scale_v, opacity_factor), ratio_factor),
        );
        let target_top = f32x4_add(
            one,
            f32x4_mul(f32x4_mul(target_scale_v, opacity_factor), ratio_factor),
        );
        let top_log_delta = unsafe { fast_ln(f32x4_div(target_top, file_top)) };

        let raw_display_opacity = f32x4_div(source_v, f32x4_mul(target_rest, target_rest));
        let encoded_display_opacity = f32x4_add(
            one,
            f32x4_mul(
                f32x4_splat(0.25),
                f32x4_sub(
                    f32x4_sqrt(f32x4_add(
                        one,
                        f32x4_mul(f32x4_splat(E), unsafe {
                            fast_ln(f32x4_min(raw_display_opacity, f32x4_splat(MAX_OPACITY)))
                        }),
                    )),
                    one,
                ),
            ),
        );
        let display_mask = f32x4_gt(raw_display_opacity, one);
        let display_opacity =
            v128_bitselect(encoded_display_opacity, raw_display_opacity, display_mask);

        if lane_count < 4 {
            for lane in 0..lane_count {
                if active_bits & (1 << lane) == 0 {
                    continue;
                }

                let base = (batch_base + lane) * 4;
                let rest_delta = unsafe { extract(rest_log_delta, lane) };
                let top_delta = unsafe { extract(top_log_delta, lane) };
                let opacity = unsafe { extract(display_opacity, lane) };
                write_scalar_fallback_lane(splat_a, splat_b, base, rest_delta, top_delta, opacity);
            }
            continue;
        }

        let active_mask = f32x4_gt(source_v, one);
        let splat_a_ptr = unsafe { splat_a.as_mut_ptr().add(batch_base * 4) };
        let splat_b_ptr = unsafe { splat_b.as_mut_ptr().add(batch_base * 4) };
        let original_word_1 = i32x4(
            unsafe { *splat_b_ptr.add(1) } as i32,
            unsafe { *splat_b_ptr.add(5) } as i32,
            unsafe { *splat_b_ptr.add(9) } as i32,
            unsafe { *splat_b_ptr.add(13) } as i32,
        );
        let original_word_2 = i32x4(
            unsafe { *splat_b_ptr.add(2) } as i32,
            unsafe { *splat_b_ptr.add(6) } as i32,
            unsafe { *splat_b_ptr.add(10) } as i32,
            unsafe { *splat_b_ptr.add(14) } as i32,
        );
        let scale_x_bits = u32x4_shr(original_word_1, 16);
        let scale_y_bits = v128_and(original_word_2, i32x4_splat(0xffff));
        let scale_z_bits = u32x4_shr(original_word_2, 16);
        let input_normal_mask = v128_and(
            unsafe { half4_normal_mask(scale_x_bits) },
            v128_and(unsafe { half4_normal_mask(scale_y_bits) }, unsafe {
                half4_normal_mask(scale_z_bits)
            }),
        );
        let scale_x = unsafe { half4_to_f32_normal(scale_x_bits) };
        let scale_y = unsafe { half4_to_f32_normal(scale_y_bits) };
        let scale_z = unsafe { half4_to_f32_normal(scale_z_bits) };
        let largest_x_mask = v128_and(f32x4_ge(scale_x, scale_y), f32x4_ge(scale_x, scale_z));
        let largest_y_mask = v128_and(v128_not(largest_x_mask), f32x4_ge(scale_y, scale_z));
        let largest_z_mask = v128_not(v128_or(largest_x_mask, largest_y_mask));
        let updated_x = f32x4_add(
            scale_x,
            v128_bitselect(top_log_delta, rest_log_delta, largest_x_mask),
        );
        let updated_y = f32x4_add(
            scale_y,
            v128_bitselect(top_log_delta, rest_log_delta, largest_y_mask),
        );
        let updated_z = f32x4_add(
            scale_z,
            v128_bitselect(top_log_delta, rest_log_delta, largest_z_mask),
        );
        let bounds_mask = v128_and(
            f32x4_le(f32x4_abs(updated_x), f32x4_splat(FLOAT16_MAX)),
            v128_and(
                f32x4_le(f32x4_abs(updated_y), f32x4_splat(FLOAT16_MAX)),
                f32x4_le(f32x4_abs(updated_z), f32x4_splat(FLOAT16_MAX)),
            ),
        );
        let (encoded_x, output_x_normal_mask) = unsafe { f32x4_to_half_normal(updated_x) };
        let (encoded_y, output_y_normal_mask) = unsafe { f32x4_to_half_normal(updated_y) };
        let (encoded_z, output_z_normal_mask) = unsafe { f32x4_to_half_normal(updated_z) };
        let fast_mask = v128_and(
            active_mask,
            v128_and(
                input_normal_mask,
                v128_and(
                    bounds_mask,
                    v128_and(
                        output_x_normal_mask,
                        v128_and(output_y_normal_mask, output_z_normal_mask),
                    ),
                ),
            ),
        );
        let updated_word_1 = v128_or(
            v128_and(original_word_1, i32x4_splat(0xffff)),
            i32x4_shl(encoded_x, 16),
        );
        let updated_word_2 = v128_or(
            v128_and(encoded_y, i32x4_splat(0xffff)),
            i32x4_shl(encoded_z, 16),
        );
        let final_word_1 = v128_bitselect(updated_word_1, original_word_1, fast_mask);
        let final_word_2 = v128_bitselect(updated_word_2, original_word_2, fast_mask);
        unsafe {
            *splat_b_ptr.add(1) = i32x4_extract_lane::<0>(final_word_1) as u32;
            *splat_b_ptr.add(2) = i32x4_extract_lane::<0>(final_word_2) as u32;
            *splat_b_ptr.add(5) = i32x4_extract_lane::<1>(final_word_1) as u32;
            *splat_b_ptr.add(6) = i32x4_extract_lane::<1>(final_word_2) as u32;
            *splat_b_ptr.add(9) = i32x4_extract_lane::<2>(final_word_1) as u32;
            *splat_b_ptr.add(10) = i32x4_extract_lane::<2>(final_word_2) as u32;
            *splat_b_ptr.add(13) = i32x4_extract_lane::<3>(final_word_1) as u32;
            *splat_b_ptr.add(14) = i32x4_extract_lane::<3>(final_word_2) as u32;
        }

        let fast_bits = i32x4_bitmask(fast_mask) as u32;
        let fast_opacity_bits =
            unsafe { write_display_opacity4(splat_a_ptr, display_opacity, fast_mask) };
        for lane in 0..4 {
            let lane_bit = 1 << lane;
            if active_bits & lane_bit == 0 {
                continue;
            }

            let base = (batch_base + lane) * 4;
            if fast_bits & lane_bit != 0 {
                if fast_opacity_bits & lane_bit == 0 {
                    let opacity = unsafe { extract(display_opacity, lane) };
                    if opacity.is_finite() {
                        write_display_opacity(splat_a, base, opacity);
                    }
                }
                continue;
            }

            let rest_delta = unsafe { extract(rest_log_delta, lane) };
            let top_delta = unsafe { extract(top_log_delta, lane) };
            let opacity = unsafe { extract(display_opacity, lane) };
            write_scalar_fallback_lane(splat_a, splat_b, base, rest_delta, top_delta, opacity);
        }
    }
}

#[unsafe(no_mangle)]
/// Applies version 2 opacity and scale retargeting to arrays in WASM memory.
///
/// # Safety
///
/// Splat pointers must reference `count * 4` writable words in this module's
/// linear memory. Metadata pointers must remain readable for `count` elements
/// at their declared strides, and the mutable splat ranges must not overlap.
pub unsafe extern "C" fn opacity_retarget(
    splat_a_ptr: u32,
    splat_b_ptr: u32,
    source_opacity_ptr: u32,
    source_opacity_stride: u32,
    ratio_ptr: u32,
    ratio_stride: u32,
    count: u32,
    file_scale: f32,
    target_scale: f32,
) {
    let count = count as usize;
    let splat_word_len = count * 4;
    let splat_a =
        unsafe { core::slice::from_raw_parts_mut(splat_a_ptr as *mut u32, splat_word_len) };
    let splat_b =
        unsafe { core::slice::from_raw_parts_mut(splat_b_ptr as *mut u32, splat_word_len) };
    unsafe {
        retarget_impl(
            splat_a,
            splat_b,
            source_opacity_ptr as *const u8,
            source_opacity_stride as usize,
            ratio_ptr as *const u8,
            ratio_stride as usize,
            count,
            file_scale,
            target_scale,
        )
    };
}
