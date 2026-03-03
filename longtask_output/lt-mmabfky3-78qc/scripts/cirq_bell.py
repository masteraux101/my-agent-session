import cirq

def run_cirq_bell():
    print("--- Cirq Bell State ---")
    try:
        # Define qubits
        q0, q1 = cirq.LineQubit.range(2)
        
        # Create circuit
        circuit = cirq.Circuit(
            cirq.H(q0),
            cirq.CNOT(q0, q1),
            cirq.measure(q0, q1, key='result')
        )
        
        # Simulate
        simulator = cirq.Simulator()
        result = simulator.run(circuit, repetitions=1000)
        counts = result.histogram(key='result')
        print(f"Results: {counts}")
        return True
    except Exception as e:
        print(f"Cirq Error: {e}")
        return False

if __name__ == "__main__":
    run_cirq_bell()
