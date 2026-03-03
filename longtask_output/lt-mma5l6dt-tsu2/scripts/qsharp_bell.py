"""
Python wrapper for Modern Q# Bell State
"""
import qsharp

def run_qsharp_bell():
    print("--- Modern Q# Bell State ---")
    # In Modern QDK, we can compile and run directly or use the .qs file
    # Here we use the qsharp.eval for a quick test
    result = qsharp.eval("BellState.GenerateBellState()")
    print(f"Measured Result: {result}")

if __name__ == "__main__":
    # Note: Requires 'bell.qs' in the same directory or defined in the session
    try:
        qsharp.init(project_root = '.')
        run_qsharp_bell()
    except Exception as e:
        print(f"Q# Execution Log: {e}")
