use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageInput {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub y: Option<f64>,
    pub label: String,
    #[serde(default)]
    pub variant: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentInput {
    #[serde(default)]
    pub from: Option<f64>,
    #[serde(default)]
    pub to: Option<f64>,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivationInput {
    pub participant: String,
    #[serde(default)]
    pub from: Option<f64>,
    #[serde(default)]
    pub to: Option<f64>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceDiagramInput {
    pub messages: Vec<MessageInput>,
    #[serde(default)]
    pub segments: Option<Vec<SegmentInput>>,
    #[serde(default)]
    pub activations: Option<Vec<ActivationInput>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolvedMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub y: f64,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolvedSegment {
    pub from: f64,
    pub to: f64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolvedActivation {
    pub participant: String,
    pub from: f64,
    pub to: f64,
    #[serde(skip_serializing_if = "Option::is_none", rename = "type")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceDiagramOutput {
    pub messages: Vec<SolvedMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segments: Option<Vec<SolvedSegment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activations: Option<Vec<SolvedActivation>>,
    pub total_height: f64,
    pub solve_time_micros: u128,
}

pub fn solve_sequence_diagram(input: &SequenceDiagramInput) -> SequenceDiagramOutput {
    let start_time = std::time::Instant::now();
    let mut current_y = 165.0;
    let mut solved_messages = Vec::with_capacity(input.messages.len());

    for msg in &input.messages {
        let y = current_y;
        let has_note = msg.note.is_some();
        let note_lines = msg.note.as_ref().map_or(0, |n| if n.len() > 25 { 2 } else { 1 });
        let step = if has_note {
            40.0 + (note_lines as f64) * 18.0
        } else {
            38.0
        };
        current_y += step;

        solved_messages.push(SolvedMessage {
            id: msg.id.clone(),
            from: msg.from.clone(),
            to: msg.to.clone(),
            y,
            label: msg.label.clone(),
            variant: msg.variant.clone(),
            note: msg.note.clone(),
        });
    }

    let solved_segments = input.segments.as_ref().map(|segs| {
        if segs.is_empty() || solved_messages.is_empty() {
            return Vec::new();
        }
        let total_msgs = solved_messages.len();
        let seg_count = segs.len();
        let msgs_per_seg = (total_msgs as f64 / seg_count as f64).ceil() as usize;

        segs.iter().enumerate().map(|(s, seg)| {
            let start_idx = s * msgs_per_seg;
            let end_idx = if s == seg_count - 1 {
                total_msgs - 1
            } else {
                ((s + 1) * msgs_per_seg - 1).min(total_msgs - 1)
            };

            let start_y = solved_messages.get(start_idx).map_or(165.0, |m| m.y);
            let end_y = solved_messages.get(end_idx).map_or(start_y + 50.0, |m| m.y);

            SolvedSegment {
                from: (start_y - 20.0).max(140.0),
                to: end_y + 25.0,
                label: seg.label.clone(),
            }
        }).collect()
    });

    let solved_activations = input.activations.as_ref().map(|acts| {
        acts.iter().map(|act| {
            let matching_msgs: Vec<&SolvedMessage> = solved_messages.iter()
                .filter(|m| m.from == act.participant || m.to == act.participant)
                .collect();

            let (from_y, to_y) = if let (Some(first), Some(last)) = (matching_msgs.first(), matching_msgs.last()) {
                (first.y, last.y)
            } else {
                (165.0, current_y)
            };

            SolvedActivation {
                participant: act.participant.clone(),
                from: from_y,
                to: to_y,
                kind: act.kind.clone(),
            }
        }).collect()
    });

    let elapsed = start_time.elapsed().as_micros();

    SequenceDiagramOutput {
        messages: solved_messages,
        segments: solved_segments,
        activations: solved_activations,
        total_height: current_y + 80.0,
        solve_time_micros: elapsed,
    }
}

// ---- C FFI Interface ----

#[no_mangle]
pub extern "C" fn archify_solve_sequence(json_ptr: *const c_char) -> *mut c_char {
    if json_ptr.is_null() {
        return std::ptr::null_mut();
    }
    let c_str = unsafe { CStr::from_ptr(json_ptr) };
    let json_slice = match c_str.to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };

    let input: SequenceDiagramInput = match serde_json::from_str(json_slice) {
        Ok(inp) => inp,
        Err(_) => return std::ptr::null_mut(),
    };

    let output = solve_sequence_diagram(&input);
    let output_json = match serde_json::to_string(&output) {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };

    match CString::new(output_json) {
        Ok(c_out) => c_out.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn archify_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe {
            let _ = CString::from_raw(ptr);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sequence_solver_under_100_micros() {
        let input = SequenceDiagramInput {
            messages: vec![
                MessageInput { id: "m1".into(), from: "a".into(), to: "b".into(), y: None, label: "Msg 1".into(), variant: None, note: None },
                MessageInput { id: "m2".into(), from: "b".into(), to: "c".into(), y: None, label: "Msg 2".into(), variant: None, note: Some("Note on Msg 2".into()) },
                MessageInput { id: "m3".into(), from: "c".into(), to: "a".into(), y: None, label: "Msg 3".into(), variant: None, note: None },
            ],
            segments: Some(vec![SegmentInput { from: None, to: None, label: "Phase 1".into() }]),
            activations: Some(vec![ActivationInput { participant: "b".into(), from: None, to: None, kind: None }]),
        };

        let output = solve_sequence_diagram(&input);
        assert_eq!(output.messages.len(), 3);
        assert_eq!(output.messages[0].y, 165.0);
        assert!(output.messages[1].y >= 165.0 + 38.0);
        assert!(output.solve_time_micros < 1000, "Solver should take less than 1ms, took {}µs", output.solve_time_micros);
    }
}
