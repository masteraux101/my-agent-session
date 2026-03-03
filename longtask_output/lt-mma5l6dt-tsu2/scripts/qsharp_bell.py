"""
Bell State Generation - Q# (Modern QDK) Implementation
This script uses the 'qsharp' Python package which interfaces with the 2026 Rust-based compiler.
"""
import qsharp

def create_bell_state():
    print("--- Q# (Modern QDK) ---")
    
    # Q# code as a string (Modern QDK style)
    qsharp_code = """
    operation CreateBellState() : Result[] {
        use (q0, q1) = (Qubit(), Qubit());
        H(q0);
        CNOT(q0, q1);
        let res = [M(q0), M(q1)];
        Reset(q0);
        Reset(q1);
        return res;
    }
    """
    
    # Compile and run
    # Note: Modern QDK allows direct execution of Q# operations from Python
    qsharp.eval(qsharp_code)
    results = qsharp.run("CreateBellState()", shots=1000)
    
    print(f"Results: {results}")

if __name__ == "__main__":
    create_bell_state()
