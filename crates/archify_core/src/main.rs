use archify_core::{solve_sequence_diagram, SequenceDiagramInput};
use std::io::{self, Read};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut buffer = String::new();

    if args.len() > 1 && args[1] != "-" {
        buffer = std::fs::read_to_string(&args[1]).expect("Failed to read input file");
    } else {
        io::stdin().read_to_string(&mut buffer).expect("Failed to read stdin");
    }

    let input: SequenceDiagramInput = serde_json::from_str(&buffer).expect("Invalid sequence JSON IR");
    let output = solve_sequence_diagram(&input);

    let stdout = serde_json::to_string_pretty(&output).expect("Failed to serialize output JSON");
    println!("{}", stdout);
}
