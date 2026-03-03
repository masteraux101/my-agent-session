import qsharp

# Modern Q# (2026) uses a seamless Python integration 
# with the Rust-based compiler backend.

qsharp_code = """
namespace BellState {
    open Microsoft.Quantum.Diagnostics;
    open Microsoft.Quantum.Measurement;

    operation GenerateBellState() : Result[] {
        use (q0, q1) = (Qubit(), Qubit());
        
        H(q0);
        CNOT(q0, q1);
        
        let results = [M(q0), M(q1)];
        
        Reset(q0);
        Reset(q1);
        
        return results;
    }
}
"""

def run_qsharp_bell():
    print("--- Q# (Modern) Bell State ---")
    # Compile the Q# code snippet
    qsharp.compile(qsharp_code)
    
    # Run the operation
    results = qsharp.eval("BellState.GenerateBellState()")
    print(f"Measured Results: {results}")

if __name__ == "__main__":
    run_qsharp_bell()
