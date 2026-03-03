import qsharp

# Modern Q# (2025/2026 standard) uses a streamlined Python interop
def create_bell_state():
    # Define the Q# operation as a string or in a .qs file
    # Here we use the inline method for the test script
    qsharp.eval("""
    operation CreateBellState() : Result[] {
        use (q0, q1) = (Qubit(), Qubit());
        H(q0);
        CNOT(q0, q1);
        let res = [M(q0), M(q1)];
        Reset(q0);
        Reset(q1);
        return res;
    }
    """)
    
    # Run the operation
    results = qsharp.run("CreateBellState()", shots=1024)
    return results

if __name__ == "__main__":
    try:
        print("Running Modern Q# Bell State...")
        # In the modern QDK, the environment is initialized automatically
        counts = create_bell_state()
        print(f"Results: {counts}")
    except Exception as e:
        # Common error in headless environments: missing .NET runtime or Q# compiler
        print(f"Q# Error: {e}")
        print("Note: Modern Q# requires the 'qsharp' python package and the 'iqsharp' or 'qsharp-compiler' components.")
