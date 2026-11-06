// Synthetic Store setup only; import/export commands are captured separately.
use remarkable_reader_buddy::storage::{Store, StorePaths};
use std::{io::{self, Read, Write}, path::PathBuf};
fn main() {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().expect("root"));
    let action = args.next().expect("action");
    let paths = StorePaths { data: root.join("data"), cache: root.join("cache"), credentials: root.join("credentials") };
    let store = Store::open(paths.clone()).expect("synthetic Store");
    if action == "hold" {
        println!("ready");io::stdout().flush().unwrap();
        let mut bytes = Vec::new();io::stdin().read_to_end(&mut bytes).unwrap();
    }
    drop(store);
    if action == "notebook" { drop(Store::prepare_notebook(paths).expect("synthetic notebook")); }
}
