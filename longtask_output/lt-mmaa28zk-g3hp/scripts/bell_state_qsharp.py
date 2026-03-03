"""
Bell State Generation in Modern Q# (2026 Rust-based compiler)
Interfaced via Python
"""
import qsharp

def run_bell_state():
    # Define the Q# operation
    qsharp_code = """
    namespace BellState {
        open Microsoft.Quantum.Measurement;
        open Microsoft.Quantum.Intrinsic;

        operation Generate() : (Result, Result) {
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
    
    # Compile the code
    qsharp.eval(qsharp_code)
    
    # Run 1024 times to simulate shots
    results = {"(Zero, Zero)": 0, "(One, One)": 0, "Other": 0}
    for _ in range(1024):
        res = qsharp.eval("BellState.Generate()")
        res_str = str(res)
        if res_str in results:
            results[res_str] += 1
        else:
            results["Other"] += 1
            
    print("Q# Bell State Execution Results:")
    print(results)

if __name__ == "__main__":
    run_bell_state()
