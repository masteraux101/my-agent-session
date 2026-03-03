import cirq

def create_bell_state():
    # Pick two qubits on a grid
    q0 = cirq.GridQubit(0, 0)
    q1 = cirq.GridQubit(0, 1)

    # Create a circuit: H on q0, then CNOT(q0, q1)
    circuit = cirq.Circuit(
        cirq.H(q0),
        cirq.CNOT(q0, q1),
        cirq.measure(q0, q1, key='result')
    )

    # Simulate the circuit locally
    simulator = cirq.Simulator()
    result = simulator.run(circuit, repetitions=1024)
    
    # Return the histogram of results
    return result.histogram(key='result')

if __name__ == "__main__":
    try:
        print("Running Cirq Bell State...")
        counts = create_bell_state()
        print(f"Results (Decimal mapping): {counts}")
    except Exception as e:
        print(f"Cirq Error: {e}")
