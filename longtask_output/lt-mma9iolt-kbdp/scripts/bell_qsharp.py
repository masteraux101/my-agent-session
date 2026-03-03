import qsharp

def run_bell_state():
    print("--- Q# (Azure Quantum Development Kit) ---")
    
    # Modern Q# Bell State Code
    qsharp_code = """
    operation CreateBellState() : (Result, Result) {
        use (q0, q1) = (Qubit(), Qubit());
        H(q0);
        CNOT(q0, q1);
        let res = (M(q0), M(q1));
        ResetAll([q0, q1]);
        return res;
    }
    """
    
    # Compile and run
    qsharp.compile(qsharp_code)
    results = []
    for _ in range(100):
        res = qsharp.eval("CreateBellState()")
        results.append(res)
    
    print(f"Sample Results (First 10): {results[:10]}")
    return results

if __name__ == "__main__":
    try:
        run_bell_state()
    except Exception as e:
        print(f"Q# Execution Error: {e}")
