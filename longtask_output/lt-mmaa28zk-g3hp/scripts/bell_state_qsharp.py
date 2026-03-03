"""
Bell State Generation - Q# (2026 Modern QDK)
Requires the 'qsharp' python package.
"""
import qsharp

# Q# code defined as a string for the modern QDK compiler
qsharp_code = """
namespace BellState {
    open Microsoft.Quantum.Diagnostics;
    open Microsoft.Quantum.Intrinsic;
    open Microsoft.Quantum.Measurement;
    open Microsoft.Quantum.Canon;

    operation GenerateBellState() : (Result, Result) {
        use (q0, q1) = (Qubit(), Qubit());
        H(q0);
        CNOT(q0, q1);
        let res = (M(q0), M(q1));
        Reset(q0);
        Reset(q1);
        return res;
    }
}
"""

def run_qsharp_bell():
    print("--- Q# Bell State Execution ---")
    # Compile the Q# code
    qsharp.eval(qsharp_code)
    
    # Run the operation multiple times
    results = []
    for _ in range(10):
        res = qsharp.run("BellState.GenerateBellState()", shots=1)
        results.append(res)
    
    print(f"Sample Results: {results}")

if __name__ == "__main__":
    try:
        run_qsharp_bell()
    except Exception as e:
        print(f"Q# Execution Error: {e}")
        print("Note: Ensure the latest Azure Quantum Development Kit is installed.")
