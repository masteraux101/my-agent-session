import cirq

def run_bell_state():
    print(f"--- Cirq Version: {cirq.__version__} ---")
    # Define qubits
    q0 = cirq.LineQubit(0)
    q1 = cirq.LineQubit(1)

    # Create circuit
    circuit = cirq.Circuit(
        cirq.H(q0),
        cirq.CNOT(q0, q1),
        cirq.measure(q0, q1, key='result')
    )

    # Simulate
    simulator = cirq.Simulator()
    result = simulator.run(circuit, repetitions=1024)
    counts = result.histogram(key='result')
    print(f"Counts (Decimal representation): {counts}")
    return counts

if __name__ == "__main__":
    try:
        run_bell_state()
    except Exception as e:
        print(f"Cirq Execution Error: {e}")
