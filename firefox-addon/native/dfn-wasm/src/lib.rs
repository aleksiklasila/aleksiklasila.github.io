//! DeepFilterNet3 for the add-on's AudioWorklet, with plain C-ABI exports (no
//! wasm-bindgen). The worklet writes one hop (480 samples at 48 kHz) into the
//! input buffer, calls `svl_process`, and reads the enhanced (speech-only) hop
//! from the output buffer.

use df::tract::{DfParams, DfTract, RuntimeParams};
use ndarray::prelude::*;
use std::ptr::null_mut;

// Inference needs no real randomness; tract's dependency tree only links
// getrandom. A fixed xorshift keeps the build free of wasm-bindgen.
fn pseudo_random(buf: &mut [u8]) -> Result<(), getrandom::Error> {
    static mut X: u64 = 0x9E37_79B9_7F4A_7C15;
    for b in buf.iter_mut() {
        unsafe {
            X ^= X << 13;
            X ^= X >> 7;
            X ^= X << 17;
            *b = X as u8;
        }
    }
    Ok(())
}
getrandom::register_custom_getrandom!(pseudo_random);

pub struct State {
    m: DfTract,
    input: Vec<f32>,
    output: Vec<f32>,
}

/// Allocate `len` bytes in wasm memory (for handing the model bytes over).
#[no_mangle]
pub extern "C" fn svl_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Free memory from `svl_alloc`.
#[no_mangle]
pub unsafe extern "C" fn svl_free(p: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(p, 0, len));
}

/// Create the model from a DeepFilterNet tar.gz ONNX model. `atten_lim` is the
/// attenuation limit in dB (100 = remove non-speech fully). Returns null on error.
#[no_mangle]
pub unsafe extern "C" fn svl_create(model: *const u8, len: usize, atten_lim: f32) -> *mut State {
    let bytes = std::slice::from_raw_parts(model, len);
    let rp = RuntimeParams::default_with_ch(1).with_atten_lim(atten_lim);
    let dfp = match DfParams::from_bytes(bytes) {
        Ok(p) => p,
        Err(_) => return null_mut(),
    };
    let m = match DfTract::new(dfp, &rp) {
        Ok(m) => m,
        Err(_) => return null_mut(),
    };
    let hop = m.hop_size;
    Box::into_raw(Box::new(State { m, input: vec![0.0; hop], output: vec![0.0; hop] }))
}

#[no_mangle]
pub unsafe extern "C" fn svl_hop(st: *mut State) -> usize {
    (*st).m.hop_size
}

/// Model look-ahead in hops (the output is delayed by this plus the STFT delay).
#[no_mangle]
pub unsafe extern "C" fn svl_lookahead(st: *mut State) -> usize {
    (*st).m.lookahead
}

#[no_mangle]
pub unsafe extern "C" fn svl_input_ptr(st: *mut State) -> *mut f32 {
    (*st).input.as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn svl_output_ptr(st: *mut State) -> *mut f32 {
    (*st).output.as_mut_ptr()
}

/// Process one hop from the input buffer into the output buffer. Returns the
/// model's local SNR estimate for the frame (dB), or -100 on error.
#[no_mangle]
pub unsafe extern "C" fn svl_process(st: *mut State) -> f32 {
    let s = &mut *st;
    let hop = s.m.hop_size;
    let inp = ArrayView2::from_shape((1, hop), &s.input[..]).unwrap();
    let out = ArrayViewMut2::from_shape((1, hop), &mut s.output[..]).unwrap();
    s.m.process(inp, out).unwrap_or(-100.0)
}

#[no_mangle]
pub unsafe extern "C" fn svl_set_atten_lim(st: *mut State, db: f32) {
    (*st).m.set_atten_lim(db)
}

#[no_mangle]
pub unsafe extern "C" fn svl_set_pf_beta(st: *mut State, beta: f32) {
    (*st).m.set_pf_beta(beta)
}
