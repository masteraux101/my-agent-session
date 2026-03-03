import qsharp

def run_qsharp_bell():
    print("--- Q# Bell State (Modern QDK) ---")
    # Using the qsharp package to run the .qs logic
    # In 2026, this is the standard way to bridge Python and Q#
    try:
        # Assuming bell.qs is in the same directory
        result = qsharp.run("BellState.GenerateBellState()")
        print(f"Result from Q# simulation: {result}")
    except Exception as e:
        print(f"Q# Execution Error: {e}")

if __name__ == "__main__":
    run_qsharp_bell()
