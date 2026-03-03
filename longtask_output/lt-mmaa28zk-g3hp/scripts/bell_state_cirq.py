import cirq

def run_bell_state():
    # Create two qubits
    q0, q1 = cirq.LineQubit.range(2)
    
    # Create a circuit
    circuit = cirq.Circuit(
        cirq.H(q0),
        cirq.CNOT(q0, q1),
        cirq.measure(q0, q1, key='result')
    )
    
    # Simulate the circuit
    simulator = cirq.Simulator()
    result = simulator.run(circuit, repetitions=1024)
    
    # Get histogram
    counts = result.histogram(key='result')
    print(f"Cirq Bell State Counts (integer keys): {counts}")

if __name__ == "__main__":
    try:
        run_bell_state()
    except Exception as e:
        print(f"Cirq Execution Error: {e}")
