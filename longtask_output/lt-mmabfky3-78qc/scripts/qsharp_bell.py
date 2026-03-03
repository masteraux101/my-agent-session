import qsharp

def run_qsharp_bell():
    print("--- Modern Q# Bell State ---")
    try:
        # Modern Q# (v1.0+) uses a simpler interface
        # We define the Q# code as a string
        qsharp_code = """
        operation CreateBellState() : (Result, Result) {
            use (q0, q1) = (Qubit(), Qubit());
            H(q0);
            CNOT(q0, q1);
            let res = (M(q0), M(q1));
            Reset(q0);
            Reset(q1);
            return res;
        }
        """
        # Execute multiple times to simulate 'shots'
        results = []
        for _ in range(10):
            res = qsharp.eval(qsharp_code)
            results.append(res)
        
        print(f"Sample Results: {results}")
        return True
    except Exception as e:
        print(f"Q# Error: {e}")
        print("Note: Ensure 'qsharp' and '.NET SDK' (if legacy) or 'Azure Quantum Development Kit' are installed.")
        return False

if __name__ == "__main__":
    run_qsharp_bell()
