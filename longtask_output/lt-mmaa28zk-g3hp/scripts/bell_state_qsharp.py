import qsharp

def run_bell_state():
    # Define the Q# operation
    # Note: Modern Q# uses a simpler syntax
    qsharp_code = """
    operation GenerateBellState() : Result[] {
        use (q0, q1) = (Qubit(), Qubit());
        H(q0);
        CNOT(q0, q1);
        let res = [M(q0), M(q1)];
        Reset(q0);
        Reset(q1);
        return res;
    }
    """
    
    # In the modern Q# Python package, we compile and run
    # Note: The API might differ slightly in 2026, 
    # but this follows the Azure Quantum SDK 1.0+ pattern.
    qsharp.eval(qsharp_code)
    results = []
    for _ in range(100):
        res = qsharp.run("GenerateBellState()")
        results.append(str(res))
    
    print(f"Q# Bell State Sample Results: {results[:5]}...")

if __name__ == "__main__":
    try:
        run_bell_state()
    except Exception as e:
        print(f"Q# Execution Error: {e}")
