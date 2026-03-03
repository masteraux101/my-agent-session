import qsharp

# Note: Modern Q# (Azure Quantum Development Kit) allows inline Q# in Python
def create_bell_state():
    qsharp.init(project_root = '.') # Initialize Q# workspace
    
    bell_code = """
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
    # In the modern QDK, we can compile and run directly
    # For a simple test, we'll use the qsharp.eval
    result = qsharp.eval("CreateBellState()")
    return result

if __name__ == "__main__":
    print("Running Q# (Modern QDK) Bell State...")
    try:
        # Note: This requires the 'qsharp' python package and .NET SDK / QDK backend
        # In a headless environment, this might need specific setup
        result = create_bell_state()
        print(f"Result: {result}")
    except Exception as e:
        print(f"Error running Q#: {e}. Ensure 'qsharp' and 'qsharp-widgets' are installed.")
